import { test, expect } from "../fixtures/auth";
import { apiUrl, fetchProfile, uploadUserPhoto } from "../support/apiClient";

/**
 * Who can read a profile photo.
 *
 * `GET /user/photo/{userId}` used to answer any caller who could name a user id.
 * It was found during the Play Store data-safety review: an unauthenticated
 * endpoint serving uploaded faces, enumerable by walking UUIDs.
 *
 * It cannot move behind the JWT — the callers are an `<img src>` on the web and an
 * `<Image uri>` on the phone, and neither can send an Authorization header — so the
 * URL carries an HMAC signature instead, minted only into `GET /user`, the one
 * response nobody but the owner can read.
 *
 * That makes the URL itself the authorization, and this spec exists because that is
 * a property nothing in the type system protects. A future change that reads the
 * bytes before checking the signature, or that answers 404 instead of 403 (turning
 * the endpoint into an oracle for which accounts have a photo), passes every unit
 * test and fails here.
 *
 * API-only on purpose: the property is the endpoint contract. Driving a browser to
 * an <img> and asserting it rendered would add flake without sharpening anything.
 */

/**
 * A real 2x2 white JPEG, 285 bytes. Inline rather than a fixture file because it is
 * a constant of this test, not data anyone would edit: the backend re-encodes every
 * upload through ImageIO, so all these bytes have to do is decode.
 *
 * Generated with:
 *   python3 -c "from PIL import Image; import io,base64; b=io.BytesIO(); \
 *     Image.new('RGB',(2,2),(255,255,255)).save(b,'JPEG',quality=20,optimize=True); \
 *     print(base64.b64encode(b.getvalue()).decode())"
 */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDACgcHiMeGSgjISMtKygwPGRBPDc3PHtYXUlkkYCZlo+A" +
    "jIqgtObDoKrarYqMyP/L2u71////m8H////6/+b9//j/2wBDASstLTw1PHZBQXb4pYyl+Pj4+Pj4" +
    "+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj/wAARCAACAAIDASIA" +
    "AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEB" +
    "AAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALIAP//Z",
  "base64",
);

/** Strip one query parameter out of the signed URL, keeping the rest intact. */
function withoutParam(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete(name);
  return parsed.toString();
}

test.describe("Profile photo access", () => {
  test("only a signed URL gets the bytes", async ({ api }) => {
    await uploadUserPhoto(api.ctx, api.accessToken, TINY_JPEG);

    // The signed URL is minted here and nowhere else. It arrives root-relative
    // (`/api/v1/user/photo/...`) because the frontend prepends its own origin.
    const { photo } = await fetchProfile(api.ctx, api.accessToken);
    expect(photo, "GET /user must hand back a photo URL after an upload").toBeTruthy();
    expect(photo).toContain("/user/photo/");

    const origin = apiUrl().replace(/\/api\/v1\/?$/, "");
    const signedUrl = `${origin}${photo}`;
    const parsed = new URL(signedUrl);
    expect(parsed.searchParams.get("sig"), "the URL must be signed").toBeTruthy();
    expect(parsed.searchParams.get("exp"), "the signature must expire").toBeTruthy();
    // The photo version still leads, so an upload busts the client image cache.
    expect(parsed.searchParams.get("v")).toBeTruthy();

    // 1. The real thing works, and no Authorization header is involved — this is
    //    what an <img src> does.
    const signed = await api.ctx.get(signedUrl);
    expect(signed.status()).toBe(200);
    expect(signed.headers()["content-type"]).toContain("image/jpeg");
    // `private`, not `public`: the URL is a capability now, and a shared cache
    // holding the bytes would keep serving them after the signature expired.
    expect(signed.headers()["cache-control"]).toContain("private");
    expect((await signed.body()).length).toBeGreaterThan(0);

    // 2. The finding itself: the bare URL, which used to return the image.
    const unsigned = await api.ctx.get(withoutParam(signedUrl, "sig"));
    expect(
      unsigned.status(),
      "an unsigned request is the bug this endpoint was fixed for",
    ).toBe(403);

    // 3. A tampered signature. Guards against a prefix comparison creeping in.
    const forged = new URL(signedUrl);
    forged.searchParams.set("sig", "forged-but-plausible-looking-value");
    expect((await api.ctx.get(forged.toString())).status()).toBe(403);

    // 4. A truncated signature, for the same reason from the other direction.
    const truncated = new URL(signedUrl);
    truncated.searchParams.set("sig", parsed.searchParams.get("sig")!.slice(0, 8));
    expect((await api.ctx.get(truncated.toString())).status()).toBe(403);

    // 5. A real signature pointed at somebody else's id. The signature is bound to
    //    one account, so it must not travel — this is what stops enumeration by a
    //    caller who legitimately holds one signed URL.
    const someoneElse = signedUrl.replace(
      /\/user\/photo\/[0-9a-f-]{36}/,
      "/user/photo/00000000-0000-4000-8000-000000000000",
    );
    expect(someoneElse).not.toBe(signedUrl);
    expect(
      (await api.ctx.get(someoneElse)).status(),
      "a signature must not carry over to another user's id",
    ).toBe(403);

    // 6. An expired-looking window. Moving `exp` invalidates the signature, which
    //    is the same refusal — the point is that the deadline is signed too and
    //    cannot be extended by editing the URL.
    const extended = new URL(signedUrl);
    extended.searchParams.set("exp", String(Number(parsed.searchParams.get("exp")) + 86_400));
    expect((await api.ctx.get(extended.toString())).status()).toBe(403);
  });

  /**
   * A caller holding nothing must not learn whether an account has a photo. 403 for
   * both cases is what keeps the endpoint from answering that question, so this
   * pins the status rather than just "not 200".
   */
  test("says nothing about whether an unknown account has a photo", async ({ api }) => {
    const origin = apiUrl().replace(/\/api\/v1\/?$/, "");
    const stranger = `${origin}/api/v1/user/photo/00000000-0000-4000-8000-000000000000`;

    expect((await api.ctx.get(stranger)).status()).toBe(403);
  });
});
