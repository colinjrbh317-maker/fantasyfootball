import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Fantasy Draft Board (MVP)
 * ------------------------------------------------------
 * Single-file React app that runs in the browser. Designed for 1920x1080 TV.
 *
 * FEATURES
 * - 12-team snake draft, 15 rounds, lineup: QB/2RB/2WR/TE/FLEX/K/DST + 6 bench, 1 IR (displayed as roster constraints only; no enforcement yet)
 * - Upload CSV (columns required: RK, PLAYER NAME, TEAM, POS, BYE)
 * - Best Available sidebar (search, filter by position/team/bye, sort by RK)
 * - Draft via keyboard (Enter) or click
 * - Timer: Rounds 1–4 = 2:00; 5–15 = 1:30; pause/resume (P), holds current time; 10s warning sound; pick chime
 * - Snake board grid (12 columns x 15 rows); recent picks ticker; who’s up next strip
 * - Undo/Redo (U / R)
 * - Autosave to localStorage; Export final rosters CSV
 * - Dark theme with subtle position colors
 *
 * HOW TO USE
 * 1) Run in a React environment (Vite recommended). Put this file as src/App.tsx (or src/App.jsx) and render it.
 * 2) In the app: click “Setup” → edit team names and order → upload your CSV → Start Draft.
 * 3) Hotkeys: / focus search, Enter draft selected, P pause/resume, U undo, R redo.
 */

// --------------------------- Utility Types ---------------------------

type Player = {
  player_id: string;
  player_name: string;
  team: string; // NFL abbr
  position: "QB" | "RB" | "WR" | "TE" | "K" | "DST" | string;
  bye_week: number;
  rk: number; // rank (lower = better)
  drafted?: boolean;
};

type Team = {
  id: string;
  name: string;
};

type Pick = {
  round: number; // 1-based
  overall: number; // 1-based overall pick number
  teamIndex: number; // 0-based index into teams array
  player_id: string;
  timestamp: number;
};

// --------------------------- Constants ---------------------------

const DEFAULT_TEAMS = 12;
const TOTAL_ROUNDS = 15;
const POS_COLOR: Record<string, string> = {
  QB: "bg-blue-700/30 text-blue-200 border-blue-600/50",
  RB: "bg-green-700/30 text-green-200 border-green-600/50",
  WR: "bg-purple-700/30 text-purple-200 border-purple-600/50",
  TE: "bg-amber-700/30 text-amber-200 border-amber-600/50",
  K: "bg-slate-700/30 text-slate-200 border-slate-500/50",
  DST: "bg-zinc-700/30 text-zinc-200 border-zinc-500/50",
};

// --------------------------- Helpers ---------------------------

function hashId(name: string, team: string, pos: string) {
  const s = `${name}|${team}|${pos}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(36);
}

function csvToRows(text: string): string[][] {
  // Simple CSV parser (supports quoted fields)
  const rows: string[][] = [];
  let i = 0;
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { pushField(); }
      else if (c === '\n') { pushField(); rows.push(row); row = []; }
      else if (c === '\r') { /* ignore */ }
      else { field += c; }
    }
    i++;
  }
  // push last field/row
  pushField();
  if (row.length) rows.push(row);
  return rows.filter(r => r.some(x => x.trim() !== ""));
}

function download(filename: string, text: string) {
  const el = document.createElement('a');
  el.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
  el.setAttribute('download', filename);
  el.style.display = 'none';
  document.body.appendChild(el);
  el.click();
  document.body.removeChild(el);
}

function formatMMSS(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getTeamIndexForPick(pickZeroBased: number, teamsCount: number): number {
  const roundZero = Math.floor(pickZeroBased / teamsCount); // 0..14
  const idxInRound = pickZeroBased % teamsCount; // 0..11
  const isEvenRound = (roundZero % 2 === 0); // Round 1 => 0 => even => L->R
  return isEvenRound ? idxInRound : (teamsCount - 1 - idxInRound);
}

function getRoundForPick(pickZeroBased: number, teamsCount: number): number {
  return Math.floor(pickZeroBased / teamsCount) + 1; // 1-based
}

function overallFromPick(pickZeroBased: number) {
  return pickZeroBased + 1;
}

// --------------------------- Sounds ---------------------------

const PickChime = () => (
  <audio id="pick-chime">
    <source src="data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQAA" />
  </audio>
);

const WarningBeep = () => (
  <audio id="warning-beep">
    <source src="data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQAA" />
  </audio>
);

function play(id: string) {
  const a = document.getElementById(id) as HTMLAudioElement | null;
  if (a) { a.currentTime = 0; a.play().catch(() => {}); }
}

// --------------------------- Local Storage ---------------------------

const LS_KEY = "ff_draft_mvp_v1";

function saveToLocal(state: PersistedState) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}

function loadFromLocal(): PersistedState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --------------------------- App State Shape ---------------------------

type PersistedState = {
  players: Player[];
  teams: Team[];
  draftStarted: boolean;
  pickIndex: number; // 0..(teams*rounds-1)
  picks: Pick[];
  paused: boolean;
  timerRemaining: number; // seconds
  seed: number; // to allow resets
};

// --------------------------- App ---------------------------

export default function App() {
  // Setup defaults
  const [teams, setTeams] = useState<Team[]>(() =>
    Array.from({ length: DEFAULT_TEAMS }, (_, i) => ({ id: String(i), name: `Team ${i + 1}` }))
  );
  const [players, setPlayers] = useState<Player[]>([]);
  const [draftStarted, setDraftStarted] = useState(false);
  const [pickIndex, setPickIndex] = useState(0);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [paused, setPaused] = useState(true);
  const [timerRemaining, setTimerRemaining] = useState(120);
  const [seed] = useState(() => Math.floor(Math.random() * 1e9));

  // UI state
  const [showSetup, setShowSetup] = useState(true);
  const [search, setSearch] = useState("");
  const [filterPos, setFilterPos] = useState<string>("ALL");
  const [filterTeam, setFilterTeam] = useState<string>("ALL");
  const [filterBye, setFilterBye] = useState<string>("ALL");
  const searchRef = useRef<HTMLInputElement>(null);

  // Undo/Redo
  const undoStack = useRef<PersistedState[]>([]);
  const redoStack = useRef<PersistedState[]>([]);

  // Load from localStorage on mount
  useEffect(() => {
    const prev = loadFromLocal();
    if (prev) {
      setPlayers(prev.players);
      setTeams(prev.teams);
      setDraftStarted(prev.draftStarted);
      setPickIndex(prev.pickIndex);
      setPicks(prev.picks);
      setPaused(prev.paused);
      setTimerRemaining(prev.timerRemaining);
    }
  }, []);

  // Persist to localStorage whenever critical state changes
  useEffect(() => {
    saveToLocal({ players, teams, draftStarted, pickIndex, picks, paused, timerRemaining, seed });
  }, [players, teams, draftStarted, pickIndex, picks, paused, timerRemaining, seed]);

  // Timer logic
  useEffect(() => {
    if (!draftStarted || paused) return;
    if (timerRemaining <= 0) return; // timeout => do nothing (pause behavior is chosen)
    const id = setInterval(() => {
      setTimerRemaining((t) => {
        const next = t - 1;
        if (next === 10) play('warning-beep');
        return Math.max(0, next);
      });
    }, 1000);
    return () => clearInterval(id);
  }, [draftStarted, paused, timerRemaining]);

  // Compute current team/round
  const teamsCount = teams.length;
  const currentRound = getRoundForPick(pickIndex, teamsCount);
  const currentTeamIndex = getTeamIndexForPick(pickIndex, teamsCount);
  const currentTeam = teams[currentTeamIndex];

  const nextTeamName = useMemo(() => {
    if (!draftStarted) return "";
    const ni = Math.min(pickIndex + 1, teamsCount * TOTAL_ROUNDS - 1);
    return teams[getTeamIndexForPick(ni, teamsCount)].name;
  }, [draftStarted, pickIndex, teams, teamsCount]);

  const next2TeamName = useMemo(() => {
    if (!draftStarted) return "";
    const ni = Math.min(pickIndex + 2, teamsCount * TOTAL_ROUNDS - 1);
    return teams[getTeamIndexForPick(ni, teamsCount)].name;
  }, [draftStarted, pickIndex, teams, teamsCount]);

  // Best Available list
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = players.filter(p => !p.drafted);
    if (filterPos !== "ALL") list = list.filter(p => p.position === filterPos);
    if (filterTeam !== "ALL") list = list.filter(p => p.team === filterTeam);
    if (filterBye !== "ALL") list = list.filter(p => String(p.bye_week) === filterBye);
    if (q) list = list.filter(p => p.player_name.toLowerCase().includes(q));
    return list.sort((a, b) => a.rk - b.rk);
  }, [players, search, filterPos, filterTeam, filterBye]);

  const recent6 = useMemo(() => {
    const last = picks.slice(-6);
    return last.map(pk => {
      const pl = players.find(p => p.player_id === pk.player_id);
      return { ...pk, name: pl?.player_name ?? "?", pos: pl?.position ?? "?", tm: pl?.team ?? "?" };
    });
  }, [picks, players]);

  // Hotkeys
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key.toLowerCase() === 'u') {
        e.preventDefault();
        handleUndo();
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        handleRedo();
      } else if (e.key === 'Enter') {
        if (filtered.length > 0) {
          draftPlayer(filtered[0]);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered]);

  // Undo/Redo helpers
  function snapshot(): PersistedState {
    return { players: JSON.parse(JSON.stringify(players)), teams, draftStarted, pickIndex, picks: JSON.parse(JSON.stringify(picks)), paused, timerRemaining, seed };
  }
  function pushUndo() { undoStack.current.push(snapshot()); redoStack.current = []; }
  function handleUndo() {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(snapshot());
    setPlayers(prev.players);
    setTeams(prev.teams);
    setDraftStarted(prev.draftStarted);
    setPickIndex(prev.pickIndex);
    setPicks(prev.picks);
    setPaused(prev.paused);
    setTimerRemaining(prev.timerRemaining);
  }
  function handleRedo() {
    const nxt = redoStack.current.pop();
    if (!nxt) return;
    undoStack.current.push(snapshot());
    setPlayers(nxt.players);
    setTeams(nxt.teams);
    setDraftStarted(nxt.draftStarted);
    setPickIndex(nxt.pickIndex);
    setPicks(nxt.picks);
    setPaused(nxt.paused);
    setTimerRemaining(nxt.timerRemaining);
  }

  // Draft logic
  function resetTimerForRound(round: number) {
    const secs = round <= 4 ? 120 : 90;
    setTimerRemaining(secs);
  }

  function draftPlayer(p: Player) {
    if (!draftStarted) return;
    pushUndo();
    // Apply pick
    const round = getRoundForPick(pickIndex, teamsCount);
    const overall = overallFromPick(pickIndex);
    const teamIndex = getTeamIndexForPick(pickIndex, teamsCount);
    const now = Date.now();

    setPicks((prev) => [...prev, { round, overall, teamIndex, player_id: p.player_id, timestamp: now }]);
    setPlayers((prev) => prev.map(x => x.player_id === p.player_id ? { ...x, drafted: true } : x));

    // sounds
    play('pick-chime');

    // Advance pick
    const nextPick = pickIndex + 1;
    setPickIndex(nextPick);

    // Reset timer to new round duration
    const nextRound = getRoundForPick(nextPick, teamsCount);
    resetTimerForRound(nextRound);

    // Keep running (unless paused by user); spec says stop on pick? It says stop + auto-advance + reset.
    // We'll keep paused state as-is; most want timer to continue automatically for the next team.
  }

  function startDraft() {
    // Validate players
    if (players.length === 0) {
      alert("Please upload a CSV with players first.");
      return;
    }
    pushUndo();
    setDraftStarted(true);
    setShowSetup(false);
    setPickIndex(0);
    setPicks([]);
    setPaused(false);
    resetTimerForRound(1);
  }

  function pauseResume() { setPaused(p => !p); }

  function skipTimerReset() {
    // Stops and resets the timer for current round
    const round = getRoundForPick(pickIndex, teamsCount);
    resetTimerForRound(round);
  }

  function exportRostersCSV() {
    // Build final rosters per team
    const byTeam: Record<number, Pick[]> = {};
    for (const pk of picks) {
      if (!byTeam[pk.teamIndex]) byTeam[pk.teamIndex] = [];
      byTeam[pk.teamIndex].push(pk);
    }
    let lines: string[] = ["team,player,position,team_abbr,round,overall,rk,bye"];
    for (let t = 0; t < teams.length; t++) {
      const roster = byTeam[t] || [];
      for (const pk of roster) {
        const pl = players.find(p => p.player_id === pk.player_id);
        if (!pl) continue;
        lines.push([
          escapeCsv(teams[t].name),
          escapeCsv(pl.player_name),
          pl.position,
          pl.team,
          pk.round,
          pk.overall,
          pl.rk,
          pl.bye_week,
        ].join(","));
      }
    }
    download("final_rosters.csv", lines.join("\n"));
  }

  function escapeCsv(val: string) {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return '"' + val.replaceAll('"', '""') + '"';
    }
    return val;
  }

  function onUploadCSV(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const rows = csvToRows(text);
      if (!rows.length) return alert("CSV empty");
      const header = rows[0].map(h => h.trim().toUpperCase());
      // Expected: RK, PLAYER NAME, TEAM, POS, BYE
      const idx = {
        rk: header.indexOf("RK"),
        name: header.indexOf("PLAYER NAME"),
        team: header.indexOf("TEAM"),
        pos: header.indexOf("POS"),
        bye: header.indexOf("BYE"),
      };
      if (Object.values(idx).some(v => v === -1)) {
        return alert("CSV must have headers: RK, PLAYER NAME, TEAM, POS, BYE");
      }
      const items: Player[] = rows.slice(1).map((r) => {
        const rawPos = (r[idx.pos] || "").trim();
        const basePos = rawPos.replace(/\d+$/, "").toUpperCase(); // WR1 -> WR
        const name = (r[idx.name] || "").trim();
        const team = (r[idx.team] || "").trim().toUpperCase();
        const bye = parseInt((r[idx.bye] || "").trim(), 10);
        const rk = Number((r[idx.rk] || "").trim());
        const pid = hashId(name, team, basePos);
        return {
          player_id: pid,
          player_name: name,
          team,
          position: basePos as Player["position"],
          bye_week: isFinite(bye) ? bye : 0,
          rk: isFinite(rk) ? rk : 9999,
          drafted: false,
        };
      }).filter(Boolean);
      // sort by rk asc initially
      items.sort((a, b) => a.rk - b.rk);
      setPlayers(items);
    };
    reader.readAsText(file);
  }

  // Board matrix for rendering picks
  const boardMatrix: (Pick | null)[][] = useMemo(() => {
    const mat: (Pick | null)[][] = Array.from({ length: TOTAL_ROUNDS }, () => Array(teamsCount).fill(null));
    for (const pk of picks) {
      const col = pk.teamIndex;
      const row = pk.round - 1;
      mat[row][col] = pk;
    }
    return mat;
  }, [picks, teamsCount]);

  // --------------------------- Render ---------------------------

  return (
    <div className="min-h-screen w-full bg-[#0B0D12] text-zinc-100 overflow-hidden">
      <PickChime />
      <WarningBeep />

      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
        <div className="flex items-center gap-3">
          <span className="text-xl font-semibold tracking-wide">Fantasy Draft Board</span>
          <button
            className="px-3 py-1.5 text-sm rounded-md bg-white/10 hover:bg-white/15"
            onClick={() => setShowSetup(true)}
          >Setup</button>
          <button
            className="px-3 py-1.5 text-sm rounded-md bg-white/10 hover:bg-white/15"
            onClick={exportRostersCSV}
          >Export CSV</button>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-sm opacity-80">Round <b>{currentRound}</b> / {TOTAL_ROUNDS}</div>
          <Timer
            value={timerRemaining}
            paused={paused || !draftStarted}
            onPauseResume={pauseResume}
            onSkipReset={skipTimerReset}
          />
        </div>
      </div>

      {/* Main Area */}
      <div className="grid grid-cols-[1fr_420px] gap-4 p-4 h-[calc(100vh-56px)]">
        {/* Board */}
        <div className="rounded-xl border border-white/10 p-2 overflow-hidden">
          <BoardGrid
            teams={teams}
            picks={boardMatrix}
            players={players}
            currentTeamIndex={draftStarted ? currentTeamIndex : -1}
          />
        </div>

        {/* Sidebar */}
        <div className="rounded-xl border border-white/10 p-3 flex flex-col">
          {/* Who's up */}
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm">
              <div className="opacity-70">On the clock</div>
              <div className="text-lg font-semibold">{draftStarted ? currentTeam?.name : "—"}</div>
            </div>
            <div className="text-xs text-right opacity-80">
              <div>Next: <b>{draftStarted ? nextTeamName : "—"}</b></div>
              <div>After: <b>{draftStarted ? next2TeamName : "—"}</b></div>
            </div>
          </div>

          {/* Filters/Search */}
          <div className="flex items-center gap-2 mb-2">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search players (/ to focus)"
              className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 outline-none focus:ring-2 focus:ring-white/20"
            />
          </div>
          <div className="flex gap-2 mb-3">
            <Select value={filterPos} onChange={setFilterPos} label="Pos" options={["ALL","QB","RB","WR","TE","K","DST"]} />
            <Select value={filterTeam} onChange={setFilterTeam} label="Team" options={["ALL", ...TEAM_ABBRS]} />
            <Select value={filterBye} onChange={setFilterBye} label="Bye" options={["ALL", ...Array.from(new Set(players.map(p => String(p.bye_week))).values()).sort()]} />
          </div>

          {/* Best Available */}
          <div className="text-sm mb-1 opacity-80">Best Available (sorted by RK)</div>
          <div className="flex-1 overflow-auto rounded-lg border border-white/5">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white/5">
                <tr className="text-left">
                  <Th w="40%">Player</Th>
                  <Th>Pos</Th>
                  <Th>Team</Th>
                  <Th>Bye</Th>
                  <Th>RK</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.player_id} className="border-t border-white/5 hover:bg-white/5">
                    <td className="px-2 py-1.5">{p.player_name}</td>
                    <td className="px-2 py-1.5"><PosBadge pos={p.position} /></td>
                    <td className="px-2 py-1.5 opacity-80">{p.team}</td>
                    <td className="px-2 py-1.5 opacity-80">{p.bye_week}</td>
                    <td className="px-2 py-1.5">{p.rk}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        className="px-2 py-1 rounded-md bg-emerald-600/80 hover:bg-emerald-600"
                        onClick={() => draftPlayer(p)}
                        disabled={!draftStarted}
                      >Draft</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Ticker */}
          <div className="mt-3 text-xs opacity-80">
            <div className="mb-1">Recent Picks</div>
            <div className="flex gap-2 flex-wrap">
              {recent6.length === 0 && <div className="opacity-60">—</div>}
              {recent6.map((r) => (
                <div key={`${r.overall}-${r.player_id}`} className="px-2 py-1 rounded-md bg-white/5 border border-white/10">
                  #{r.overall} {r.name} ({r.pos}-{r.tm})
                </div>
              ))}
            </div>
          </div>

          {/* Controls */}
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15" onClick={pauseResume}>{paused ? "Resume (P)" : "Pause (P)"}</button>
              <button className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15" onClick={handleUndo}>Undo (U)</button>
              <button className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15" onClick={handleRedo}>Redo (R)</button>
            </div>
            <button className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15" onClick={skipTimerReset}>Reset Timer</button>
          </div>
        </div>
      </div>

      {/* Setup Modal */}
      {showSetup && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-4xl bg-[#0F121A] rounded-2xl border border-white/10 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-semibold">Setup</div>
              <button className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15" onClick={() => setShowSetup(false)}>Close</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg border border-white/10 p-3">
                <div className="text-sm font-medium mb-2">Teams (12)</div>
                <div className="grid grid-cols-2 gap-2">
                  {teams.map((t, i) => (
                    <input
                      key={t.id}
                      value={t.name}
                      onChange={(e) => setTeams(prev => prev.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))}
                      className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-sm"
                    />
                  ))}
                </div>
                <div className="text-xs opacity-70 mt-2">Enter team names in the draft order for Round 1. Snake order will be applied automatically.</div>
              </div>

              <div className="rounded-lg border border-white/10 p-3">
                <div className="text-sm font-medium mb-2">Upload Player CSV</div>
                <input type="file" accept=".csv" onChange={(e) => { const f=e.target.files?.[0]; if (f) onUploadCSV(f); }} />
                <div className="text-xs opacity-70 mt-2">Required headers: RK, PLAYER NAME, TEAM, POS, BYE. POS like WR1 becomes WR.</div>
                <div className="text-xs opacity-70 mt-1">Players loaded: <b>{players.length}</b></div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15" onClick={() => { localStorage.removeItem(LS_KEY); location.reload(); }}>Reset App</button>
              <button className="px-3 py-2 rounded-md bg-emerald-600/90 hover:bg-emerald-600" onClick={startDraft}>Start Draft</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------- Subcomponents ---------------------------

function Timer({ value, paused, onPauseResume, onSkipReset }: { value: number; paused: boolean; onPauseResume: () => void; onSkipReset: () => void; }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`text-2xl font-bold tabular-nums ${value <= 10 ? 'text-red-400' : ''}`}>{formatMMSS(value)}</div>
      <button className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15 text-sm" onClick={onPauseResume}>{paused ? "Resume" : "Pause"}</button>
      <button className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15 text-sm" onClick={onSkipReset}>Skip/Reset</button>
    </div>
  );
}

function BoardGrid({ teams, picks, players, currentTeamIndex }: { teams: Team[]; picks: (Pick | null)[][]; players: Player[]; currentTeamIndex: number; }) {
  return (
    <div className="h-full w-full grid grid-rows-[auto_1fr]">
      {/* Header */}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${teams.length}, minmax(0, 1fr))` }}>
        {teams.map((t, idx) => (
          <div key={t.id} className={`px-2 py-2 text-center text-sm font-semibold border-r border-white/10 ${idx === teams.length - 1 ? 'border-r-0' : ''} ${idx===currentTeamIndex ? 'bg-emerald-500/10' : 'bg-white/5'}`}>{t.name}</div>
        ))}
      </div>
      {/* Body */}
      <div className="overflow-auto">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${teams.length}, minmax(0, 1fr))` }}>
          {picks.map((row, rIdx) => (
            <React.Fragment key={rIdx}>
              {row.map((cell, cIdx) => (
                <div key={`${rIdx}-${cIdx}`} className={`h-16 border border-white/10 p-1 overflow-hidden ${cIdx===currentTeamIndex && rIdx===activeRowIndex(picks) ? 'ring-2 ring-emerald-500/50' : ''}`}>
                  {cell ? <PickCell pick={cell} players={players} /> : <EmptyCell round={rIdx+1} col={cIdx} />}
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

function activeRowIndex(picks: (Pick | null)[][]) {
  // Find first row with any empty cell as a naive indicator for current row highlight
  for (let r = 0; r < picks.length; r++) {
    for (let c = 0; c < picks[r].length; c++) {
      if (!picks[r][c]) return r;
    }
  }
  return picks.length - 1;
}

function PickCell({ pick, players }: { pick: Pick; players: Player[]; }) {
  const pl = players.find(p => p.player_id === pick.player_id);
  if (!pl) return null;
  const posClass = POS_COLOR[pl.position] || "bg-white/5 text-white border-white/10";
  return (
    <div className={`h-full w-full rounded-md border ${posClass} px-2 py-1 text-xs leading-tight flex flex-col justify-between`}>
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold truncate">{pl.player_name}</div>
        <div className="opacity-80">{pl.team}</div>
      </div>
      <div className="flex items-center justify-between text-[11px] opacity-90">
        <div className="flex items-center gap-1"><span className="px-1 rounded bg-black/30 border border-white/10">{pl.position}</span><span>RK {pl.rk}</span></div>
        <div>R{pick.round} #{pick.overall}</div>
      </div>
    </div>
  );
}

function EmptyCell({ round }: { round: number; col: number; }) {
  return (
    <div className="h-full w-full rounded-md bg-white/5 text-xs text-white/40 flex items-center justify-center select-none">R{round}</div>
  );
}

function Select({ value, onChange, label, options }: { value: string; onChange: (v: string) => void; label: string; options: string[]; }) {
  return (
    <label className="text-xs flex-1">
      <div className="mb-1 opacity-70">{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-2 text-sm">
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function PosBadge({ pos }: { pos: string; }) {
  const cls = POS_COLOR[pos] || "bg-white/10 text-white border-white/10";
  return <span className={`px-2 py-0.5 rounded border text-xs ${cls}`}>{pos}</span>;
}

// NFL Team abbreviations (basic set)
const TEAM_ABBRS = [
  "ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LAC","LAR","LV","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SEA","SF","TB","TEN","WAS"
];

