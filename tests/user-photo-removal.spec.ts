import { test, expect } from "../fixtures/auth";
import {
  deleteUserPhoto,
  editUser,
  exportUserData,
  fetchProfile,
  uploadUserPhoto,
} from "../support/apiClient";

/**
 * Removing a profile photo, and finding it in the export.
 *
 * Both halves of this came from one piece of user feedback: the photo could not be
 * removed, and it was missing from the data export. They had separate causes and the
 * same root, which is that a photo is stored in two unrelated places — an uploaded
 * JPEG on disk, and `perfilPhoto`, a Google CDN URL on the user row — and the app
 * reads them in priority order, the file first.
 *
 * That priority is what made every partial fix fail:
 *
 *   - There was no DELETE at all. Removal existed only as part of deleting the whole
 *     account.
 *   - The one removal-shaped call a client could reach, `PUT /user` with an empty
 *     `photo`, clears the column the server does not consult while a file exists. The
 *     photo came straight back on the next profile read.
 *   - Deleting only the file drops a Google user back to their old avatar, so the
 *     Remove button appears to swap the photo rather than remove it.
 *   - The export read the column and nothing else, so it reported `"photo": null` for
 *     every account that uploaded rather than signing in with Google, while the app
 *     went on showing that same photo.
 *
 * So the assertions here are end-state assertions, taken from what a client actually
 * reads. Checking that the file left the disk, or that the column is null, is checking
 * one half of a two-half bug — either can pass while the user still sees a face.
 */

/**
 * A real 2x2 white JPEG, 285 bytes. Same constant as `user-photo-access.spec.ts`:
 * the backend re-encodes every upload through ImageIO, so all these bytes must do is
 * decode.
 */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDACgcHiMeGSgjISMtKygwPGRBPDc3PHtYXUlkkYCZlo+A" +
    "jIqgtObDoKrarYqMyP/L2u71////m8H////6/+b9//j/2wBDASstLTw1PHZBQXb4pYyl+Pj4+Pj4" +
    "+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj/wAARCAACAAIDASIA" +
    "AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEB" +
    "AAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALIAP//Z",
  "base64",
);

test.describe("Profile photo removal", () => {
  test("DELETE /user/photo stops the profile serving the photo", async ({ api }) => {
    await uploadUserPhoto(api.ctx, api.accessToken, TINY_JPEG);

    const before = await fetchProfile(api.ctx, api.accessToken);
    expect(before.photo, "the fixture is only meaningful with a photo in place").toContain(
      "/user/photo/",
    );

    const response = await deleteUserPhoto(api.ctx, api.accessToken);
    expect(response.status(), "removal returns 204 with no body").toBe(204);

    const after = await fetchProfile(api.ctx, api.accessToken);
    expect(
      after.photo,
      "the client is still being handed a photo URL, which is the whole complaint",
    ).toBeFalsy();
  });

  test("removing is idempotent — an account with no photo is already in the asked-for state", async ({
    api,
  }) => {
    const first = await deleteUserPhoto(api.ctx, api.accessToken);
    expect(first.status(), "no photo to remove is not an error").toBe(204);

    const second = await deleteUserPhoto(api.ctx, api.accessToken);
    expect(second.status()).toBe(204);
  });

  test("an empty photo edit does NOT remove an uploaded photo — only DELETE does", async ({
    api,
  }) => {
    await uploadUserPhoto(api.ctx, api.accessToken, TINY_JPEG);

    // The workaround a client might reach for, and the reason this endpoint had to
    // exist. It clears `perfilPhoto`, which the server skips while a file is stored,
    // so the photo survives. Locked in so nobody "simplifies" the DELETE away by
    // pointing the UI at this instead.
    await editUser(api.ctx, api.accessToken, { photo: "" });

    const stillThere = await fetchProfile(api.ctx, api.accessToken);
    expect(
      stillThere.photo,
      "an empty photo edit leaves the uploaded file serving, which is why DELETE exists",
    ).toContain("/user/photo/");

    await deleteUserPhoto(api.ctx, api.accessToken);
    const gone = await fetchProfile(api.ctx, api.accessToken);
    expect(gone.photo).toBeFalsy();
  });

  test("the export carries the uploaded photo as bytes that decode back to an image", async ({
    api,
  }) => {
    await uploadUserPhoto(api.ctx, api.accessToken, TINY_JPEG);

    const exported = await exportUserData(api.ctx, api.accessToken);
    const profile = exported.profile as Record<string, unknown>;
    const photo = profile.photo as Record<string, unknown> | null;

    expect(
      photo,
      "this read null for every account that uploaded a photo, because the export was " +
        "reading the column the upload never writes",
    ).toBeTruthy();
    expect(photo!.source).toBe("UPLOAD");
    expect(photo!.contentType).toBe("image/jpeg");
    expect(photo!.readError, "the bytes were readable, so nothing to report").toBeUndefined();

    // Decoded rather than merely present. A non-empty string here could be a path, a
    // URL or a placeholder, and none of those is the photo.
    const decoded = Buffer.from(photo!.base64 as string, "base64");
    expect(decoded.length).toBe(photo!.sizeBytes);
    // JPEG's magic number. Cheap, and it is the difference between real bytes and
    // something that merely looks like base64.
    expect(decoded.subarray(0, 3).toString("hex")).toBe("ffd8ff");
  });

  test("after removal the export reports no photo rather than a stale reference", async ({
    api,
  }) => {
    await uploadUserPhoto(api.ctx, api.accessToken, TINY_JPEG);
    await deleteUserPhoto(api.ctx, api.accessToken);

    const exported = await exportUserData(api.ctx, api.accessToken);
    const profile = exported.profile as Record<string, unknown>;

    expect(profile).toHaveProperty("photo");
    expect(
      profile.photo,
      "an export naming a photo the account no longer has is the same dishonesty pointing the other way",
    ).toBeNull();
  });

  test("the configuration screen removes the photo through the UI", async ({ authedPage, api }) => {
    await uploadUserPhoto(api.ctx, api.accessToken, TINY_JPEG);

    await authedPage.goto("/configuration");

    // Through the screen on purpose: an API-level spec cannot see a component that
    // stops sending the call, because it never goes through the component.
    await authedPage.getByRole("button", { name: /change photo/i }).click();

    const removeButton = authedPage.getByRole("button", { name: /^remove photo$/i });
    await expect(removeButton).toBeVisible();

    // Two taps: the first only asks. Confirms the guard is really there rather than
    // the button being wired straight to the call.
    await removeButton.click();
    await authedPage.getByRole("button", { name: /^remove photo$/i }).click();

    await expect
      .poll(async () => (await fetchProfile(api.ctx, api.accessToken)).photo, {
        message: "the UI must reach DELETE /user/photo, not just clear its own state",
      })
      .toBeFalsy();
  });
});
