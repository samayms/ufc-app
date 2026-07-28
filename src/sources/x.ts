import xFixtureJson from "../fixtures/x.json" with { type: "json" };
import type { Corner, ScorecardEmbed } from "../schema.ts";

export type XIntegrationMode = "disabled" | "embed" | "manual" | "api";
export type ExpertScoreMode = "embed" | "manual" | "api";

export interface ExpertRoundScore {
  red: number;
  blue: number;
}

export interface ParsedExpertScore {
  source: "x";
  sourcePostId: string;
  scorer: string;
  round: number;
  score: ExpertRoundScore;
  fetchedAt: string;
  parseConfidence: number;
  mode: ExpertScoreMode;
  postUrl: string;
}

export interface XConfiguredScore {
  boutId: string;
  sourcePostId: string;
  scorer: string;
  round: number;
  score: ExpertRoundScore;
  postUrl?: string;
  fetchedAt?: string;
  parseConfidence?: number;
}

export interface XEmbedMetadata {
  boutId: string;
  postId: string;
  scorer: string;
  round?: number;
  postUrl?: string;
  fetchedAt?: string;
}

export interface XApiRoundRequest {
  boutId: string;
  round: number;
  bearerToken: string;
}

export type XApiFetcher = (
  request: XApiRoundRequest,
) => Promise<unknown>;

export interface XSourceOptions {
  mode: XIntegrationMode;
  bearerToken?: string;
  embeds?: readonly XEmbedMetadata[];
  manualScores?: readonly XConfiguredScore[];
  apiFetcher?: XApiFetcher;
  fixtureMode?: boolean;
  now?: () => string;
}

export interface XScoreSource {
  readonly mode: XIntegrationMode;
  configuredScores(boutId: string, round: number): ParsedExpertScore[];
  configuredEmbeds(boutId?: string): ScorecardEmbed[];
  fetchApiScores(boutId: string, round: number): Promise<ParsedExpertScore[]>;
}

interface XFixture {
  embeds: XEmbedMetadata[];
  manualScores: XConfiguredScore[];
  apiScores: XConfiguredScore[];
}

const xFixture = xFixtureJson as XFixture;
const DEFAULT_FIXTURE_TIME = "2026-07-26T02:41:00Z";
const X_POST_URL =
  /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]{1,15}\/status\/(\d+)(?:[/?#].*)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanText(value: string, maxLength: number): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validScore(score: unknown): score is ExpertRoundScore {
  return (
    isRecord(score) &&
    typeof score.red === "number" &&
    Number.isSafeInteger(score.red) &&
    score.red >= 0 &&
    score.red <= 100 &&
    typeof score.blue === "number" &&
    Number.isSafeInteger(score.blue) &&
    score.blue >= 0 &&
    score.blue <= 100
  );
}

function postUrl(sourcePostId: string, scorer: string, explicit?: string): string {
  if (explicit !== undefined) {
    const match = X_POST_URL.exec(explicit.trim());
    if (match?.[1] === sourcePostId) return explicit.trim();
  }
  const handle = cleanText(scorer, 15)
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9_]/g, "");
  return `https://x.com/${handle || "i"}/status/${sourcePostId}`;
}

function normalizeConfigured(
  value: XConfiguredScore,
  mode: ExpertScoreMode,
  fallbackFetchedAt: string,
): ParsedExpertScore | null {
  const sourcePostId = cleanText(String(value.sourcePostId), 40);
  const scorer = cleanText(String(value.scorer), 120);
  const fetchedAt = value.fetchedAt ?? fallbackFetchedAt;
  const parseConfidence = value.parseConfidence ?? (mode === "manual" ? 1 : 0.95);
  if (
    !/^\d{1,40}$/.test(sourcePostId) ||
    scorer.length === 0 ||
    !Number.isSafeInteger(value.round) ||
    value.round < 1 ||
    value.round > 5 ||
    !validScore(value.score) ||
    !Number.isFinite(Date.parse(fetchedAt)) ||
    !Number.isFinite(parseConfidence) ||
    parseConfidence < 0 ||
    parseConfidence > 1
  ) {
    return null;
  }

  return {
    source: "x",
    sourcePostId,
    scorer,
    round: value.round,
    score: { ...value.score },
    fetchedAt,
    parseConfidence,
    mode,
    postUrl: postUrl(sourcePostId, scorer, value.postUrl),
  };
}

function normalizeEmbed(
  value: XEmbedMetadata,
  fallbackFetchedAt: string,
  synthetic: boolean,
): ScorecardEmbed | null {
  const postId = cleanText(String(value.postId), 40);
  const scorer = cleanText(String(value.scorer), 120)
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 15);
  const fetchedAt = value.fetchedAt ?? fallbackFetchedAt;
  if (
    value.boutId.trim().length === 0 ||
    !/^\d{1,40}$/.test(postId) ||
    scorer.length === 0 ||
    (value.round !== undefined &&
      (!Number.isSafeInteger(value.round) ||
        value.round < 1 ||
        value.round > 5)) ||
    !Number.isFinite(Date.parse(fetchedAt))
  ) {
    return null;
  }
  return {
    boutId: value.boutId,
    handle: scorer,
    postId,
    ...(value.round === undefined ? {} : { round: value.round }),
    provenance: {
      source: "x-embed",
      fetchedAt,
      synthetic,
    },
  };
}

function parseApiPayload(
  payload: unknown,
  boutId: string,
  round: number,
  fetchedAt: string,
): ParsedExpertScore[] {
  if (!Array.isArray(payload) || payload.length > 100) return [];
  const seen = new Set<string>();
  const scores: ParsedExpertScore[] = [];

  for (const candidate of payload) {
    if (
      !isRecord(candidate) ||
      candidate.boutId !== boutId ||
      candidate.round !== round ||
      typeof candidate.sourcePostId !== "string" ||
      typeof candidate.scorer !== "string" ||
      !validScore(candidate.score)
    ) {
      continue;
    }
    const normalized = normalizeConfigured(
      {
        boutId,
        sourcePostId: candidate.sourcePostId,
        scorer: candidate.scorer,
        round,
        score: candidate.score,
        ...(typeof candidate.postUrl === "string"
          ? { postUrl: candidate.postUrl }
          : {}),
        fetchedAt,
        ...(typeof candidate.parseConfidence === "number"
          ? { parseConfidence: candidate.parseConfidence }
          : {}),
      },
      "api",
      fetchedAt,
    );
    if (normalized === null || seen.has(normalized.sourcePostId)) continue;
    seen.add(normalized.sourcePostId);
    scores.push(normalized);
  }
  return scores;
}

function uniqueConfigured(
  configured: readonly XConfiguredScore[],
  mode: ExpertScoreMode,
  boutId: string,
  round: number,
  fetchedAt: string,
): ParsedExpertScore[] {
  const unique = new Map<string, ParsedExpertScore>();
  for (const value of configured) {
    if (value.boutId !== boutId || value.round !== round) continue;
    const normalized = normalizeConfigured(value, mode, fetchedAt);
    if (normalized !== null && !unique.has(normalized.sourcePostId)) {
      unique.set(normalized.sourcePostId, normalized);
    }
  }
  return [...unique.values()];
}

export function scoreWinner(score: ExpertRoundScore): Corner | "draw" {
  return score.red > score.blue
    ? "red"
    : score.blue > score.red
      ? "blue"
      : "draw";
}

export function createXSource(options: XSourceOptions): XScoreSource {
  if (options.mode === "api" && !options.bearerToken?.trim()) {
    throw new Error("X API mode requires a bearer token");
  }

  const now = options.now ?? (() => new Date().toISOString());
  const fixtureMode = options.fixtureMode ?? false;
  const embeds = options.embeds ?? (fixtureMode ? xFixture.embeds : []);
  const manualScores =
    options.manualScores ?? (fixtureMode ? xFixture.manualScores : []);
  const apiFetcher =
    options.apiFetcher ??
    (fixtureMode
      ? async ({ boutId, round }: XApiRoundRequest) =>
          xFixture.apiScores.filter(
            (score) => score.boutId === boutId && score.round === round,
          )
      : undefined);

  return {
    mode: options.mode,
    configuredScores(boutId, round) {
      if (options.mode === "manual") {
        return uniqueConfigured(
          manualScores,
          "manual",
          boutId,
          round,
          fixtureMode ? DEFAULT_FIXTURE_TIME : now(),
        );
      }
      return [];
    },
    configuredEmbeds(boutId) {
      if (options.mode !== "embed") return [];
      const unique = new Map<string, ScorecardEmbed>();
      for (const configured of embeds) {
        if (boutId !== undefined && configured.boutId !== boutId) continue;
        const normalized = normalizeEmbed(
          configured,
          fixtureMode ? DEFAULT_FIXTURE_TIME : now(),
          fixtureMode,
        );
        if (normalized !== null && !unique.has(normalized.postId)) {
          unique.set(normalized.postId, normalized);
        }
      }
      return [...unique.values()];
    },
    async fetchApiScores(boutId, round) {
      if (options.mode !== "api") return [];
      if (apiFetcher === undefined) {
        throw new Error("X API mode has no configured fetch hook");
      }
      const fetchedAt = now();
      const payload = await apiFetcher({
        boutId,
        round,
        bearerToken: options.bearerToken!,
      });
      return parseApiPayload(payload, boutId, round, fetchedAt);
    },
  };
}
