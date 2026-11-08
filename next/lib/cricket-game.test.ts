import { beforeEach, describe, expect, it, vi } from "vitest";
import { S9_PLAYERS, S9_TEAMS, type CricketInningsState } from "@sports-fiesta/domain";

const { tables } = vi.hoisted(() => ({ tables: new Map<string, Map<string, Record<string, unknown>>>() }));
vi.mock("./supabase-admin", () => {
  function table(name: string) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  }
  return {
    CommandError: class extends Error {
      constructor(public statusCode: number, public code: string, message: string) { super(message); }
    },
    newId: () => crypto.randomUUID(),
    nowIso: () => new Date().toISOString(),
    getDocument: async (name: string, id: string) => structuredClone(table(name).get(id) ?? null),
    listDocuments: async (name: string) => structuredClone([...table(name).values()]),
    upsertDocument: async (name: string, id: string, value: Record<string, unknown>) => { table(name).set(id, structuredClone(value)); },
    deleteDocument: async (name: string, id: string) => { table(name).delete(id); },
    updateMatchByRevision: async (id: string, revision: number, value: Record<string, unknown>) => {
      if (table("matches").get(id)?.revision !== revision) return null;
      table("matches").set(id, structuredClone(value));
      return structuredClone(value);
    },
    supabaseAdmin: {},
  };
});
import * as commands from "./command-handlers";

type Match = { revision: number; status: string; winnerTeamId?: string; resultText?: string; manOfTheMatchPlayerId?: string; cricket: { innings: { state: CricketInningsState }[]; currentInnings: number } };
const home = S9_TEAMS[0].id;
const away = S9_TEAMS[1].id;
const roster = (team: string) => S9_PLAYERS.filter((p) => p.teamId === team);
const match = () => tables.get("matches")!.get("simulation") as unknown as Match;
const state = () => match().cricket.innings[match().cricket.currentInnings].state;
type Handler = (data: Record<string, unknown>) => Promise<unknown>;
async function run(handler: Handler, data: Record<string, unknown> = {}) {
  return handler({ matchId: "simulation", commandId: crypto.randomUUID(), expectedRevision: match().revision, ...data });
}
async function start(batting: string, bowling: string, superOver = false) {
  await run(commands.handleStartInnings, { battingTeamId: batting, bowlingTeamId: bowling, strikerId: roster(batting)[0].id, nonStrikerId: roster(batting)[1].id, bowlerId: roster(bowling)[0].id, superOver });
}
async function ball(delivery: Record<string, unknown>) {
  if (!state().currentBowlerId) await run(commands.handleSelectCricketBowler, { playerId: state().bowlingLineup[Math.floor(state().legalBalls / 6)] });
  await run(commands.handleRecordCricketDelivery, { delivery });
}

beforeEach(() => {
  tables.clear();
  tables.set("players", new Map(S9_PLAYERS.map((p) => [p.id, { ...p }])));
  tables.set("teams", new Map(S9_TEAMS.map((p) => [p.id, { ...p }])));
  tables.set("matches", new Map([["simulation", { id: "simulation", sport: "cricket", stage: "league", homeTeamId: home, awayTeamId: away, status: "scheduled", revision: 0 }]]));
});

describe("entire cricket game through organizer commands", () => {
  it("scores both innings, handles undo/retry/conflicts, completes awards and publishes standings", async () => {
    await run(commands.handleSetToss, { winnerTeamId: home, decision: "bat" });
    await start(home, away);
    await ball({ runsOffBat: 0, extraType: "wide", extraRuns: 1 });
    await ball({ runsOffBat: 4, extraType: "no-ball", extraRuns: 1 });
    await ball({ runsOffBat: 0, extraType: "bye", extraRuns: 2 });
    await ball({ runsOffBat: 6 });
    await run(commands.handleUndoLastEvent);
    expect(state().score).toBe(8);
    expect(state().legalBalls).toBe(1);
    await ball({ runsOffBat: 4 });
    await ball({ runsOffBat: 0, dismissal: { type: "caught", playerOutId: state().strikerId, fielderId: roster(away)[2].id } });
    await run(commands.handleSelectNextBatter, { playerId: roster(home)[3].id });
    const retry = { matchId: "simulation", commandId: crypto.randomUUID(), expectedRevision: match().revision, delivery: { runsOffBat: 1 } };
    await commands.handleRecordCricketDelivery(retry);
    const revision = match().revision;
    await commands.handleRecordCricketDelivery(retry);
    expect(match().revision).toBe(revision);
    await expect(commands.handleRecordCricketDelivery({ ...retry, commandId: crypto.randomUUID() })).rejects.toThrow(/out of sync/i);
    while (!state().completed) await ball({ runsOffBat: 1 });
    expect(state()).toMatchObject({ score: 39, wickets: 1, legalBalls: 30 });
    expect(match().status).toBe("innings-break");
    await start(away, home);
    while (!state().completed) await ball({ runsOffBat: 2 });
    expect(state()).toMatchObject({ score: 40, wickets: 0, legalBalls: 20 });
    await run(commands.handleEndMatch);
    expect(match().status).toBe("completed");
    expect(match().winnerTeamId).toBe(away);
    expect(match().manOfTheMatchPlayerId).toBeTruthy();
    const standings = tables.get("standings")!.get("cricket")!.rows as { teamId: string; points: number; played: number }[];
    expect(standings.find((r) => r.teamId === away)).toMatchObject({ points: 2, played: 1 });
    expect(standings.find((r) => r.teamId === home)).toMatchObject({ points: 0, played: 1 });
    expect(tables.get("leaderboards")!.get("cricket")).toBeTruthy();
  });

  it("cannot finalize a tied match while its Super Over reply is pending", async () => {
    await start(home, away);
    await run(commands.handleEndInnings);
    await start(away, home);
    await run(commands.handleEndInnings);
    await start(home, away, true);
    await run(commands.handleEndInnings);
    expect(match().status).toBe("super-over");
    await expect(run(commands.handleEndMatch)).rejects.toThrow(/result.*ready/i);
  });
  it("plays a Super Over reply and only then finalizes the winner", async () => {
    await start(home, away);
    await run(commands.handleEndInnings);
    await start(away, home);
    await run(commands.handleEndInnings);
    await start(home, away, true);
    await ball({ runsOffBat: 6 });
    while (!state().completed) await ball({ runsOffBat: 0 });
    await start(away, home, true);
    expect(match().resultText).toBeNull();
    await expect(run(commands.handleEndMatch)).rejects.toThrow(/result.*ready/i);
    await ball({ runsOffBat: 1 });
    await ball({ runsOffBat: 6 });
    expect(state().completed).toBe(true);
    expect(match().winnerTeamId).toBe(away);
    await run(commands.handleEndMatch);
    expect(match().status).toBe("completed");
    expect(match().resultText).toContain("Super Over");
  });

  it("ends a Super Over on a second-wicket run-out without asking for another batter", async () => {
    await start(home, away);
    await run(commands.handleEndInnings);
    await start(away, home);
    await run(commands.handleEndInnings);
    await start(home, away, true);
    await ball({ runsOffBat: 0, dismissal: { type: "bowled", playerOutId: state().strikerId } });
    await run(commands.handleSelectNextBatter, { playerId: roster(home)[2].id });
    await ball({ runsOffBat: 1, dismissal: { type: "run-out", playerOutId: state().strikerId, fielderId: roster(away)[1].id }, nextStrikerId: state().nonStrikerId });
    expect(state()).toMatchObject({ score: 1, wickets: 2, legalBalls: 2, completed: true });
    expect(match().status).toBe("super-over");
    await expect(run(commands.handleSelectNextBatter, { playerId: roster(home)[3].id })).rejects.toThrow();
  });

});
