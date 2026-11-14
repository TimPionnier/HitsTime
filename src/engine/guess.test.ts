import { describe, expect, it } from "vitest";
import {
  allowedTypos,
  checkGuess,
  isFullGuess,
  levenshtein,
  matchesArtist,
  matchesTitle,
  normalizeGuess,
} from "./guess";

describe("normalizeGuess", () => {
  it("ignores case, accents, spaces and punctuation", () => {
    expect(normalizeGuess("  Sapés Comme Jamais ! ")).toBe("sapescommejamais");
    expect(normalizeGuess("D.A.N.C.E")).toBe("dance");
    expect(normalizeGuess("Knockin’ On Heaven's Door")).toBe("knockinonheavensdoor");
  });

  it("drops a leading article", () => {
    expect(normalizeGuess("The White Stripes")).toBe("whitestripes");
    expect(normalizeGuess("La maladie d'amour")).toBe("maladiedamour");
    expect(normalizeGuess("L'Aventurier")).toBe("aventurier");
  });

  it("keeps a word that merely starts like an article", () => {
    expect(normalizeGuess("Lady")).toBe("lady");
    expect(normalizeGuess("Therapy")).toBe("therapy");
  });

  it("never reduces a name made only of articles to nothing", () => {
    expect(normalizeGuess("The The")).toBe("the");
  });

  it("reads & as and", () => {
    expect(normalizeGuess("Earth, Wind & Fire")).toBe(normalizeGuess("earth wind and fire"));
  });
});

describe("levenshtein", () => {
  it("counts insertions, deletions and substitutions", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("sade", "sada")).toBe(1);
  });
});

describe("allowedTypos", () => {
  it("scales with the length of the answer and is capped", () => {
    expect(allowedTypos(4)).toBe(0);
    expect(allowedTypos(5)).toBe(1);
    expect(allowedTypos(9)).toBe(1);
    expect(allowedTypos(10)).toBe(2);
    expect(allowedTypos(15)).toBe(3);
    expect(allowedTypos(40)).toBe(3);
  });
});

describe("matchesTitle", () => {
  it("accepts the exact title whatever the case and accents", () => {
    expect(matchesTitle("seven nation army", "Seven Nation Army")).toBe(true);
    expect(
      matchesTitle("sapes comme jamais", "Sapés comme jamais (feat. Niska) (Pilule bleue)"),
    ).toBe(true);
  });

  it("forgives light typos", () => {
    expect(matchesTitle("seven nation amry", "Seven Nation Army")).toBe(true);
    expect(matchesTitle("smoth operator", "Smooth Operator")).toBe(true);
    expect(matchesTitle("halelujah", "Hallelujah")).toBe(true);
  });

  it("rejects a typo in a very short title", () => {
    expect(matchesTitle("suger", "Sugar")).toBe(true);
    expect(matchesTitle("kisa", "Kiss")).toBe(false);
  });

  it("rejects a different or partial title", () => {
    expect(matchesTitle("seven", "Seven Nation Army")).toBe(false);
    expect(matchesTitle("kiss of life", "Your Love Is King")).toBe(false);
    expect(matchesTitle("", "Sugar")).toBe(false);
    expect(matchesTitle("   ", "Sugar")).toBe(false);
  });

  it("ignores version noise in the reference title", () => {
    expect(matchesTitle("what is love", "What Is Love (7” Mix)")).toBe(true);
    expect(matchesTitle("ma baker", "Ma Baker (ZDF Starparade 02.06.1977)")).toBe(true);
    expect(matchesTitle("hot stuff", "Hot Stuff - Remastered 2011")).toBe(true);
    expect(matchesTitle("billie jean", "Billie Jean - Single Version")).toBe(true);
    expect(matchesTitle("stan", "Stan feat. Dido")).toBe(true);
    expect(matchesTitle("boogie wonderland", "Boogie Wonderland (with The Emotions)")).toBe(true);
  });

  it("keeps a dash that is part of the title", () => {
    expect(matchesTitle("say it loud", "Say It Loud - I'm Black and I'm Proud")).toBe(false);
    expect(
      matchesTitle("say it loud im black and im proud", "Say It Loud - I'm Black and I'm Proud"),
    ).toBe(true);
  });

  it("accepts a bracketed part typed in full or left out", () => {
    expect(matchesTitle("satisfaction", "(I Can't Get No) Satisfaction")).toBe(true);
    expect(matchesTitle("i cant get no satisfaction", "(I Can't Get No) Satisfaction")).toBe(true);
    expect(matchesTitle("run the world", "Run the World (Girls)")).toBe(true);
    expect(matchesTitle("run the world girls", "Run the World (Girls)")).toBe(true);
  });
});

describe("matchesArtist", () => {
  it("accepts the artist with typos, accents or a missing article", () => {
    expect(matchesArtist("beyonce", "Beyoncé")).toBe(true);
    expect(matchesArtist("white stripes", "The White Stripes")).toBe(true);
    expect(matchesArtist("the white stipes", "The White Stripes")).toBe(true);
    expect(matchesArtist("micheal sardou", "Michel Sardou")).toBe(true);
    expect(matchesArtist("acdc", "AC/DC")).toBe(true);
    expect(matchesArtist("boney m", "Boney M.")).toBe(true);
  });

  it("rejects another artist", () => {
    expect(matchesArtist("sade", "Cerrone")).toBe(false);
    expect(matchesArtist("bob marley", "Bob Dylan")).toBe(false);
    expect(matchesArtist("", "Sade")).toBe(false);
  });

  it("accepts one of several credited artists", () => {
    expect(matchesArtist("simon", "Simon & Garfunkel")).toBe(true);
    expect(matchesArtist("garfunkel", "Simon & Garfunkel")).toBe(true);
    expect(matchesArtist("simon and garfunkel", "Simon & Garfunkel")).toBe(true);
    expect(matchesArtist("dido", "Eminem feat. Dido")).toBe(true);
    expect(matchesArtist("earth wind and fire", "Earth, Wind & Fire")).toBe(true);
  });

  it("does not accept a first name or a surname alone", () => {
    expect(matchesArtist("sardou", "Michel Sardou")).toBe(false);
    expect(matchesArtist("michel", "Michel Sardou")).toBe(false);
    expect(matchesArtist("stripes", "The White Stripes")).toBe(false);
  });

  it("does not accept a credited artist too short to stand alone", () => {
    expect(matchesArtist("m", "Boney M.")).toBe(false);
    expect(matchesArtist("jay", "Jay & Bob")).toBe(false);
  });
});

describe("checkGuess", () => {
  const track = { title: "Smooth Operator", artist: "Sade" };

  it("scores title and artist independently", () => {
    expect(checkGuess({ title: "smooth operator", artist: "sade" }, track)).toEqual({
      titleFound: true,
      artistFound: true,
    });
    expect(checkGuess({ title: "smooth operator", artist: "" }, track)).toEqual({
      titleFound: true,
      artistFound: false,
    });
    expect(checkGuess({ title: "jezebel", artist: "Sade" }, track)).toEqual({
      titleFound: false,
      artistFound: true,
    });
  });

  it("does not credit the artist typed in the title field", () => {
    expect(checkGuess({ title: "sade", artist: "smooth operator" }, track)).toEqual({
      titleFound: false,
      artistFound: false,
    });
  });
});

describe("isFullGuess", () => {
  it("needs both the title and the artist", () => {
    expect(isFullGuess({ titleFound: true, artistFound: true })).toBe(true);
    expect(isFullGuess({ titleFound: true, artistFound: false })).toBe(false);
    expect(isFullGuess({ titleFound: false, artistFound: true })).toBe(false);
    expect(isFullGuess({ titleFound: false, artistFound: false })).toBe(false);
  });

  it("is false for a round recorded outside hard mode", () => {
    expect(isFullGuess({})).toBe(false);
  });
});
