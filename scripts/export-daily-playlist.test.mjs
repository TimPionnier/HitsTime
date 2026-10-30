import { describe, expect, it } from "vitest";
import {
  buildJspf,
  latestShardName,
  oldestFirst,
  parseArgs,
  parseSpotifyEmbed,
  playlistTitle,
  recordPlaylist,
  rankAnyVersion,
  rankFaithful,
  spotifyGap,
  tracksOf,
} from "./export-daily-playlist.mjs";

const challenge = {
  date: "2026-10-12",
  dayIndex: 30,
  anchor: { id: "1", title: "Anchor", artist: "A" },
  draw: [
    { id: "2", title: "Two", artist: "B" },
    { id: "3", title: "Three", artist: "C" },
  ],
};

describe("latestShardName", () => {
  it("picks the most recent date and ignores other files", () => {
    const names = ["2026-09-13.json", "2026-10-02.json", "index.html", "2026-09-30.json"];
    expect(latestShardName(names)).toBe("2026-10-02.json");
  });

  it("returns null when there is no shard", () => {
    expect(latestShardName(["notes.txt"])).toBeNull();
  });
});

describe("playlistTitle", () => {
  it("carries the challenge number", () => {
    expect(playlistTitle(30)).toBe("HitsTime Daily Challenge #30");
  });
});

describe("tracksOf", () => {
  it("puts the anchor first, then the rounds in order", () => {
    expect(tracksOf(challenge).map((track) => track.id)).toEqual(["1", "2", "3"]);
  });
});

const recording = (id, overrides = {}) => ({
  id,
  title: "Yeah!",
  length: 250_000,
  "artist-credit": [{ name: "USHER" }, { name: "Lil Jon" }],
  ...overrides,
});
const ids = (recordings) => recordings.map((entry) => entry.id);

describe("rankFaithful", () => {
  const track = { title: "Yeah! (feat. Lil Jon & Ludacris)", artist: "USHER" };

  it("ignores a feat. suffix on our title and extra credited artists", () => {
    expect(ids(rankFaithful(track, 250, [recording("a")]))).toEqual(["a"]);
  });

  it("puts the recording whose length is closest to ours first", () => {
    const recordings = [
      recording("far", { length: 280_000 }),
      recording("near", { length: 251_000 }),
    ];
    expect(ids(rankFaithful(track, 250, recordings))).toEqual(["near", "far"]);
  });

  it("rejects recordings with another title or another artist", () => {
    const recordings = [
      recording("title", { title: "Yeah Yeah" }),
      recording("artist", { "artist-credit": [{ name: "Someone Else" }] }),
    ];
    expect(rankFaithful(track, 250, recordings)).toEqual([]);
  });

  it("rejects mixes, live takes and covers unless our title asks for one", () => {
    const dj = recording("dj", { disambiguation: "part of Super Bowl Megamix DJ-mix" });
    expect(rankFaithful(track, 250, [dj])).toEqual([]);

    const live = recording("live", { title: "Yeah! (live 1981)" });
    expect(rankFaithful(track, 250, [live])).toEqual([]);

    const remixTrack = { title: "Yeah! (Remix)", artist: "USHER" };
    expect(ids(rankFaithful(remixTrack, 250, [dj]))).toEqual(["dj"]);
  });

  it("rejects recordings far longer or shorter than ours", () => {
    expect(rankFaithful(track, 250, [recording("long", { length: 400_000 })])).toEqual([]);
  });

  it("accepts a recording that has no length", () => {
    expect(ids(rankFaithful(track, 250, [recording("a", { length: undefined })]))).toEqual(["a"]);
  });
});

describe("rankAnyVersion", () => {
  const track = { title: "Knockin' On Heaven's Door", artist: "Bob Dylan" };
  const dylan = (id, overrides = {}) =>
    recording(id, {
      title: "Knockin' On Heaven's Door",
      length: 340_000,
      "artist-credit": [{ name: "Bob Dylan" }],
      ...overrides,
    });

  it("accepts a version of a very different length", () => {
    expect(ids(rankAnyVersion(track, 150, [dylan("long")]))).toEqual(["long"]);
  });

  it("ranks a studio-like version before a live one, whatever the length", () => {
    const recordings = [
      dylan("live", { title: "Knockin' On Heaven's Door (live)", length: 150_000 }),
      dylan("studio", { length: 340_000 }),
    ];
    expect(ids(rankAnyVersion(track, 150, recordings))).toEqual(["studio", "live"]);
  });

  it("still requires the same song and artist", () => {
    const recordings = [
      dylan("title", { title: "Another Song" }),
      dylan("artist", { "artist-credit": [{ name: "Guns N' Roses" }] }),
    ];
    expect(rankAnyVersion(track, 150, recordings)).toEqual([]);
  });
});

describe("parseSpotifyEmbed", () => {
  const page = (entity) =>
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { state: { data: { entity } } } },
    })}</script></html>`;

  it("reads the release year and the length in seconds", () => {
    const html = page({ releaseDate: { isoString: "2013-08-31T00:00:00Z" }, duration: 218360 });
    expect(parseSpotifyEmbed(html)).toEqual({ year: 2013, seconds: 218 });
  });

  it("returns null when the page has no data or an unexpected shape", () => {
    expect(parseSpotifyEmbed("<html></html>")).toBeNull();
    expect(parseSpotifyEmbed(page({}))).toBeNull();
    expect(parseSpotifyEmbed('<script id="__NEXT_DATA__">not json</script>')).toBeNull();
  });
});

describe("spotifyGap", () => {
  it("is faithful when year and length are close to the game's", () => {
    const gap = spotifyGap({ year: 1964, seconds: 270 }, 1964, 269);
    expect(gap.faithful).toBe(true);
  });

  it("is not faithful for a compilation released decades later", () => {
    expect(spotifyGap({ year: 2013, seconds: 218 }, 1964, 269).faithful).toBe(false);
  });

  it("is not faithful when the length is far off, even in the right year", () => {
    expect(spotifyGap({ year: 1979, seconds: 315 }, 1979, 224).faithful).toBe(false);
  });

  it("scores a closer track lower, and an unreadable one worst", () => {
    const near = spotifyGap({ year: 1976, seconds: 206 }, 1976, 206).score;
    const compilation = spotifyGap({ year: 1984, seconds: 206 }, 1976, 206).score;
    expect(near).toBeLessThan(compilation);
    expect(spotifyGap(null, 1976, 206).score).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("parseArgs", () => {
  it("separates the date, the dry-run flag and the data file", () => {
    expect(parseArgs(["2026-10-29", "--dry-run", "--data-file", "data/playlists.json"])).toEqual({
      dateArg: "2026-10-29",
      dryRun: true,
      dataFile: "data/playlists.json",
    });
  });

  it("does not take the data file path for a date", () => {
    expect(parseArgs(["--data-file", "data/playlists.json"]).dateArg).toBeNull();
  });
});

describe("recordPlaylist", () => {
  const challenge = { dayIndex: 47, date: "2026-10-29" };

  it("adds the day and keeps the earlier ones", () => {
    const earlier = { 46: { date: "2026-10-28", url: "https://open.spotify.com/playlist/a" } };
    const result = recordPlaylist(earlier, challenge, "https://open.spotify.com/playlist/b");
    expect(Object.keys(result)).toEqual(["46", "47"]);
    expect(result["47"]).toEqual({
      date: "2026-10-29",
      url: "https://open.spotify.com/playlist/b",
    });
  });

  it("does not modify the object it is given", () => {
    const earlier = {};
    recordPlaylist(earlier, challenge, "https://open.spotify.com/playlist/b");
    expect(earlier).toEqual({});
  });
});

describe("oldestFirst", () => {
  it("orders by release year and keeps play order within a year", () => {
    const resolved = [
      { track: { id: "1", year: 1990 }, mbid: "a" },
      { track: { id: "2", year: 1975 }, mbid: "b" },
      { track: { id: "3", year: 1990 }, mbid: "c" },
      { track: { id: "4", year: 1982 }, mbid: "d" },
    ];
    expect(oldestFirst(resolved).map((entry) => entry.mbid)).toEqual(["b", "d", "a", "c"]);
  });

  it("does not modify the list it is given", () => {
    const resolved = [
      { track: { year: 2000 }, mbid: "a" },
      { track: { year: 1990 }, mbid: "b" },
    ];
    oldestFirst(resolved);
    expect(resolved.map((entry) => entry.mbid)).toEqual(["a", "b"]);
  });
});

describe("buildJspf", () => {
  const resolved = [
    { track: { ...challenge.draw[1], year: 1990 }, mbid: "ccc" },
    { track: { ...challenge.anchor, year: 1970 }, mbid: "aaa" },
  ];
  const jspf = buildJspf(challenge, resolved);

  it("is public and titled with the challenge number", () => {
    expect(jspf.title).toBe("HitsTime Daily Challenge #30");
    expect(jspf.extension["https://musicbrainz.org/doc/jspf#playlist"].public).toBe(true);
  });

  it("lists only the resolved tracks, oldest first, as MusicBrainz recording URLs", () => {
    expect(jspf.track.map((track) => track.identifier)).toEqual([
      "https://musicbrainz.org/recording/aaa",
      "https://musicbrainz.org/recording/ccc",
    ]);
  });

  it("gives every track the extension ListenBrainz's exporter requires", () => {
    for (const track of jspf.track) {
      expect(track.extension["https://musicbrainz.org/doc/jspf#track"]).toBeDefined();
    }
  });
});
