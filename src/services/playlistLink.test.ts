import { describe, expect, it } from "vitest";
import { parsePlaylistUrl } from "./playlistLink";

const links = {
  "47": { date: "2026-10-29", url: "https://open.spotify.com/playlist/abc123" },
  "48": { date: "2026-10-30", url: "https://evil.example/playlist/abc123" },
  "49": { date: "2026-10-31" },
};

describe("parsePlaylistUrl", () => {
  it("returns the Spotify address recorded for the day", () => {
    expect(parsePlaylistUrl(links, 47)).toBe("https://open.spotify.com/playlist/abc123");
  });

  it("returns null for a day with no entry", () => {
    expect(parsePlaylistUrl(links, 46)).toBeNull();
  });

  it("refuses an address that is not a Spotify playlist", () => {
    expect(parsePlaylistUrl(links, 48)).toBeNull();
  });

  it("returns null for an entry without an address", () => {
    expect(parsePlaylistUrl(links, 49)).toBeNull();
  });

  it("returns null for data that is not an object", () => {
    expect(parsePlaylistUrl(null, 47)).toBeNull();
    expect(parsePlaylistUrl("nope", 47)).toBeNull();
    expect(parsePlaylistUrl([], 47)).toBeNull();
  });
});
