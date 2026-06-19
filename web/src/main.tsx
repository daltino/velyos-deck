import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AudioLines,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Download,
  FileMusic,
  FolderOpen,
  Gauge,
  HardDrive,
  KeyRound,
  Languages,
  ListMusic,
  Music2,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  StopCircle,
  Trash2,
  Wand2
} from 'lucide-react';
import './styles.css';

type Language = 'cs' | 'en';
type ClientConfig = { apiToken?: string };

type AppState = {
  status: string;
  toolStatus: Record<string, boolean>;
  settings: SettingsState;
  library: { tracks: number; ready: number; missing: number };
  jobs: Job[];
};

type SettingsState = {
  destination: string;
  quality: string;
  soundcloudMode: number;
  enhanceMode: string;
  enhanceAudioSR: boolean;
  topLimit: number;
  options: Record<string, unknown>;
  ui: Record<string, unknown>;
};

type Track = {
  id: string;
  path: string;
  title: string;
  artist: string;
  bpm: number;
  key: string;
  camelot: string;
  genre: string;
  tags: string[];
  energy: string;
  updated_at: number;
};

type SetRow = { name: string; count: number; ids: string[]; updated_at: number };
type SetsState = { active_set: string; sets: SetRow[] };
type Job = {
  id: string;
  name: string;
  kind: string;
  status: string;
  progress: number;
  message: string;
  error?: string | null;
  created_at: number;
  updated_at: number;
  repeated_from?: string | null;
  result?: Record<string, unknown>;
};
type DialogResponse = { paths: string[] };
type ImportResponse = { count: number; skipped: string[] };
type FsNode = {
  id: string;
  name: string;
  path: string;
  kind: string;
  hasChildren: boolean;
  audioCount: number;
};
type FsAudioFile = { path: string; name: string; size: number; updated_at: number };
type LibraryRow = {
  key: string;
  path: string;
  title: string;
  artist: string;
  bpm?: number;
  keyName?: string;
  camelot?: string;
  energy?: string;
  trackId?: string;
  imported: boolean;
};

const text = {
  cs: {
    brandSub: 'Lokální DJ knihovna',
    loadingState: 'Načítám stav',
    tracks: 'tracků',
    ready: 'ready',
    refresh: 'Obnovit',
    liveDeck: 'Live Deck',
    nav: {
      library: 'Knihovna',
      download: 'Stahování',
      quality: 'Kvalita',
      similar: 'Podobné',
      enhance: 'Enhance',
      live: 'Live',
      jobs: 'Joby',
      settings: 'Nastavení'
    },
    titles: {
      library: 'DJ knihovna / PREP',
      download: 'Stahování',
      quality: 'Hledání kvality',
      similar: 'Podobné tracky',
      enhance: 'Enhance / Master',
      live: 'Live Deck',
      jobs: 'Joby',
      settings: 'Nastavení'
    },
    common: {
      add: 'Přidat',
      files: 'Soubory',
      folder: 'Složka',
      folders: 'Složky',
      clear: 'Vyčistit',
      save: 'Uložit',
      start: 'Spustit',
      remove: 'Odebrat',
      imported: 'V knihovně',
      notImported: 'Soubor',
      noneSelected: 'Nic nevybráno',
      error: 'Chyba'
    },
    library: {
      filter: 'Filtrovat název, artistu, Camelot nebo cestu',
      manualPath: '/Users/.../track.flac',
      selectFiltered: 'Vybrat filtrované',
      analyze: 'Analyzovat',
      stems: 'Stems',
      folderTree: 'Složky',
      folderHint: 'Rozklikni disk nebo složku a vyber, co chceš importovat nebo analyzovat.',
      showRecursive: 'Včetně podsložek',
      importFolder: 'Importovat složku',
      analyzeFolder: 'Analyzovat složku',
      currentFolder: 'Vybraná složka',
      allTracks: 'Všechny tracky',
      title: 'Název',
      artist: 'Artist',
      bpm: 'BPM',
      key: 'Key',
      camelot: 'Camelot',
      energy: 'Energy',
      path: 'Cesta',
      source: 'Zdroj',
      prep: 'PREP / Sety',
      prepCount: 'tracků ve frontě',
      setSaved: 'Set uložen',
      importedCount: 'Importováno',
      skipped: 'přeskočeno',
      folderLoaded: 'Složka načtena',
      pickerFailed: 'Výběr složky/souboru selhal',
      noAudio: 'Ve vybrané složce nejsou audio soubory.',
      noTracks: 'Žádné tracky neodpovídají filtru.'
    },
    download: {
      queue: 'Fronta stahování',
      placeholder: 'SoundCloud / YouTube / Bandcamp / Spotify URL nebo hledaný text',
      destination: 'Cílová složka',
      jobName: 'Název jobu',
      jobNamePlaceholder: 'Např. páteční playlist nebo Club Master batch',
      started: 'Download job spuštěn'
    },
    quality: {
      placeholder: 'Artist - Název',
      probe: 'Prověřit',
      notice: 'Quality search',
      empty: 'Zadej artistu a název tracku.',
      started: 'Quality job spuštěn',
      done: 'Quality hotová',
      failed: 'Quality selhala',
      cancel: 'Zrušit quality job'
    },
    similar: {
      placeholder: 'Seed track nebo YouTube URL',
      find: 'Najít',
      notice: 'Nalezeno podobných tracků',
      empty: 'Zadej seed track nebo YouTube URL.',
      started: 'Similar job spuštěn',
      done: 'Similar hotovo',
      failed: 'Similar selhalo',
      cancel: 'Zrušit similar job'
    },
    enhance: {
      mode: 'Režim',
      jobName: 'Název jobu',
      jobNamePlaceholder: 'Např. analyzovat PREP nebo Club Master set',
      manual: 'Manual',
      club: 'Club Master',
      manualHelp: 'Manual používá jen filtry, které zapneš níže.',
      clubHelp: 'Club Master ignoruje ruční filtry a použije pevný mastering preset.',
      manualFilters: 'Ruční filtry',
      clubPreset: 'Club Master preset',
      clubPresetItems: ['2-pass loudnorm: -9 LUFS, LRA 7, TP -1.0', 'Stereo výstup, 48 kHz, 24-bit WAV', 'Soubor se uloží jako `_club.wav` do `_enhanced`'],
      denoise: 'Potlačí stálý šum a ruch před exportem.',
      brightness: 'Přidá jemnou výškovou čitelnost a vzduch.',
      stereo_widen: 'Rozšíří stereo obraz; pro mono-kompatibilní klubové hraní ho nech vypnutý.',
      loudnorm: 'Srovná hlasitost, aby exporty držely podobnou úroveň.',
      enhanceAction: 'Vylepšit',
      enhanceHelp: 'Vytvoří zpracované audio ve složce `_enhanced`.',
      analyzeAction: 'Analyzovat vstupy',
      analyzeHelp: 'Načte BPM, key, Camelot a připravenost metadat.',
      stemsAction: 'Stems vstupy',
      stemsHelp: 'Spustí separaci vocal/drums/bass/other.',
      inputs: 'Vstupy',
      libraryInput: 'Vstupy z knihovny používají aktuálně vybrané řádky v Library.',
      chooseFiles: 'Vybrat soubory',
      chooseFolders: 'Vybrat složky',
      pickerHelp: 'Soubory jsou přesné vstupy, složky zpracují podporované audio uvnitř.',
      includeSubfolders: 'Včetně podsložek',
      folderRecursiveOn: 'Vybrané složky se zpracují včetně všech podsložek.',
      folderRecursiveOff: 'Zpracují se jen audio soubory přímo ve vybraných složkách.',
      manualPathsHelp: 'Ruční cesty: jedna lokální cesta k souboru na řádek.',
      librarySelection: 'Výběr z knihovny',
      librarySelectionHelp: 'Tyto tracky se posílají backendu podle track id.',
      fileListHelp: 'Jednotlivé soubory se zpracují přesně podle seznamu.',
      folderListHelp: 'Složky backend zpracuje rekurzivně.',
      statusTitle: 'Stav analýzy',
      polling: 'Kontroluji každých 1,5 s do dokončení nebo chyby',
      noAnalyze: 'Z této obrazovky zatím neběží Analyze job',
      startAnalyze: 'Spusť Analyze a stav uvidíš tady.',
      refreshLibrary: 'Obnovit knihovnu',
      cancelJob: 'Zrušit job',
      jobId: 'Job ID',
      message: 'Zpráva',
      waiting: 'Čekám na update workeru',
      done: 'Analyze job hotov',
      failed: 'Analyze job skončil chybou'
    },
    jobs: {
      refresh: 'Obnovit joby',
      cancel: 'Zrušit',
      repeat: 'Opakovat',
      saveName: 'Uložit název',
      id: 'ID',
      name: 'Název',
      kind: 'Typ',
      status: 'Stav',
      progress: 'Průběh',
      message: 'Zpráva',
      actions: 'Akce',
      unnamed: 'Bez názvu',
      stalePrefix: 'Bez odezvy',
      minutes: 'min'
    },
    live: {
      wrapper: 'Live Deck wrapper',
      start: 'Start',
      refresh: 'Obnovit',
      open: 'Otevřít Deck'
    },
    settings: {
      localDefaults: 'Lokální výchozí nastavení',
      destination: 'Cílová složka',
      quality: 'Kvalita',
      language: 'Jazyk',
      czech: 'Čeština',
      english: 'English',
      connections: 'Připojení služeb',
      connectionsHelp: 'Bez developer credentials teď ukládáme jen nastavení a tokeny pro nástroje, které už aplikace používá.',
      scToken: 'SoundCloud OAuth token',
      scHelp: 'Použije se pro `scdl --auth-token`; nech prázdné, pokud ho nepotřebuješ.',
      spotifyClient: 'Spotify client ID',
      spotifyHelp: 'Rezervováno pro pozdější OAuth/PKCE import playlistů; spotDL dál funguje pro URL.',
      tidalClient: 'TIDAL client ID',
      tidalHelp: 'Zatím jen připravené pole. Plné TIDAL napojení doděláme po credentials.',
      configured: 'Nastaveno',
      notConfigured: 'Nenastaveno',
      saved: 'Nastavení uloženo'
    }
  },
  en: {
    brandSub: 'Local DJ library',
    loadingState: 'Loading state',
    tracks: 'tracks',
    ready: 'ready',
    refresh: 'Refresh',
    liveDeck: 'Live Deck',
    nav: {
      library: 'Library',
      download: 'Download',
      quality: 'Quality',
      similar: 'Similar',
      enhance: 'Enhance',
      live: 'Live',
      jobs: 'Jobs',
      settings: 'Settings'
    },
    titles: {
      library: 'DJ Library / PREP',
      download: 'Download',
      quality: 'Quality Search',
      similar: 'Similar Tracks',
      enhance: 'Enhance / Master',
      live: 'Live Deck',
      jobs: 'Jobs',
      settings: 'Settings'
    },
    common: {
      add: 'Add',
      files: 'Files',
      folder: 'Folder',
      folders: 'Folders',
      clear: 'Clear',
      save: 'Save',
      start: 'Start',
      remove: 'Remove',
      imported: 'In library',
      notImported: 'File',
      noneSelected: 'Nothing selected',
      error: 'Error'
    },
    library: {
      filter: 'Filter title, artist, Camelot, or path',
      manualPath: '/Users/.../track.flac',
      selectFiltered: 'Select filtered',
      analyze: 'Analyze',
      stems: 'Stems',
      folderTree: 'Folders',
      folderHint: 'Expand a disk or folder and choose what to import or analyze.',
      showRecursive: 'Include subfolders',
      importFolder: 'Import folder',
      analyzeFolder: 'Analyze folder',
      currentFolder: 'Selected folder',
      allTracks: 'All tracks',
      title: 'Title',
      artist: 'Artist',
      bpm: 'BPM',
      key: 'Key',
      camelot: 'Camelot',
      energy: 'Energy',
      path: 'Path',
      source: 'Source',
      prep: 'PREP / Sets',
      prepCount: 'tracks in queue',
      setSaved: 'Set saved',
      importedCount: 'Imported',
      skipped: 'skipped',
      folderLoaded: 'Folder loaded',
      pickerFailed: 'File/folder picker failed',
      noAudio: 'No audio files in the selected folder.',
      noTracks: 'No tracks match the filter.'
    },
    download: {
      queue: 'Download queue',
      placeholder: 'SoundCloud / YouTube / Bandcamp / Spotify URL or search text',
      destination: 'Destination',
      jobName: 'Job name',
      jobNamePlaceholder: 'For example Friday playlist or Club Master batch',
      started: 'Download job started'
    },
    quality: {
      placeholder: 'Artist - Title',
      probe: 'Probe',
      notice: 'Quality search',
      empty: 'Enter an artist and track title.',
      started: 'Quality job started',
      done: 'Quality done',
      failed: 'Quality failed',
      cancel: 'Cancel quality job'
    },
    similar: {
      placeholder: 'Seed track or YouTube URL',
      find: 'Find',
      notice: 'Similar tracks found',
      empty: 'Enter a seed track or YouTube URL.',
      started: 'Similar job started',
      done: 'Similar done',
      failed: 'Similar failed',
      cancel: 'Cancel similar job'
    },
    enhance: {
      mode: 'Mode',
      jobName: 'Job name',
      jobNamePlaceholder: 'For example analyze PREP or Club Master set',
      manual: 'Manual',
      club: 'Club Master',
      manualHelp: 'Manual applies only the filters you choose below.',
      clubHelp: 'Club Master ignores manual filters and uses a fixed mastering preset.',
      manualFilters: 'Manual filters',
      clubPreset: 'Club Master preset',
      clubPresetItems: ['2-pass loudnorm: -9 LUFS, LRA 7, TP -1.0', 'Stereo output, 48 kHz, 24-bit WAV', 'Saved as `_club.wav` inside `_enhanced`'],
      denoise: 'Reduces steady hiss and background noise before export.',
      brightness: 'Adds gentle high-end clarity and air.',
      stereo_widen: 'Widens the stereo image; leave off for mono-safe club playback.',
      loudnorm: 'Normalizes loudness so exports stay consistent.',
      enhanceAction: 'Enhance',
      enhanceHelp: 'Creates processed audio files in `_enhanced`.',
      analyzeAction: 'Analyze inputs',
      analyzeHelp: 'Reads BPM, key, Camelot, and metadata readiness.',
      stemsAction: 'Stems inputs',
      stemsHelp: 'Runs vocal/drums/bass/other stem separation.',
      inputs: 'Inputs',
      libraryInput: 'Library inputs use the rows selected in Library.',
      chooseFiles: 'Choose files',
      chooseFolders: 'Choose folders',
      pickerHelp: 'Files are exact inputs; folders process supported audio inside them.',
      includeSubfolders: 'Include subfolders',
      folderRecursiveOn: 'Selected folders are processed including every subfolder.',
      folderRecursiveOff: 'Only audio files directly inside selected folders are processed.',
      manualPathsHelp: 'Manual paths accept one local file path per line.',
      librarySelection: 'Library selection',
      librarySelectionHelp: 'These tracks are sent to the backend by track id.',
      fileListHelp: 'Individual files are processed exactly as listed.',
      folderListHelp: 'Folders are processed recursively by the backend job.',
      statusTitle: 'Analyze status',
      polling: 'Polling every 1.5 s until done or error',
      noAnalyze: 'No Analyze job started from this view yet',
      startAnalyze: 'Start Analyze to track its status here.',
      refreshLibrary: 'Refresh library',
      cancelJob: 'Cancel job',
      jobId: 'Job ID',
      message: 'Message',
      waiting: 'Waiting for worker update',
      done: 'Analyze job done',
      failed: 'Analyze job failed'
    },
    jobs: {
      refresh: 'Refresh jobs',
      cancel: 'Cancel',
      repeat: 'Repeat',
      saveName: 'Save name',
      id: 'ID',
      name: 'Name',
      kind: 'Kind',
      status: 'Status',
      progress: 'Progress',
      message: 'Message',
      actions: 'Actions',
      unnamed: 'Unnamed',
      stalePrefix: 'No response for',
      minutes: 'min'
    },
    live: {
      wrapper: 'Live Deck wrapper',
      start: 'Start',
      refresh: 'Refresh',
      open: 'Open Deck'
    },
    settings: {
      localDefaults: 'Local defaults',
      destination: 'Destination',
      quality: 'Quality',
      language: 'Language',
      czech: 'Čeština',
      english: 'English',
      connections: 'Service connections',
      connectionsHelp: 'Without developer credentials, this pass stores settings and tokens for tools the app already uses.',
      scToken: 'SoundCloud OAuth token',
      scHelp: 'Used for `scdl --auth-token`; leave empty when not needed.',
      spotifyClient: 'Spotify client ID',
      spotifyHelp: 'Reserved for later OAuth/PKCE playlist import; spotDL still works for URLs.',
      tidalClient: 'TIDAL client ID',
      tidalHelp: 'Prepared field only. Full TIDAL integration follows after credentials.',
      configured: 'Configured',
      notConfigured: 'Not configured',
      saved: 'Settings saved'
    }
  }
} as const;

type Texts = (typeof text)[Language];

const nav = [
  ['library', ListMusic],
  ['download', Download],
  ['quality', Gauge],
  ['similar', Sparkles],
  ['enhance', Wand2],
  ['live', Play],
  ['jobs', Activity],
  ['settings', Settings]
] as const;

let clientConfigPromise: Promise<ClientConfig> | null = null;

async function clientConfig(): Promise<ClientConfig> {
  if (!clientConfigPromise) {
    clientConfigPromise = fetch('/api/client-config')
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
  }
  return clientConfigPromise;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const config = await clientConfig();
  const headers = new Headers(init?.headers || undefined);
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (config.apiToken && !headers.has('X-SCDL-GUI-Token')) headers.set('X-SCDL-GUI-Token', config.apiToken);
  const res = await fetch(url, {
    headers,
    ...init
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isActiveJob(job?: Job | null) {
  return job?.status === 'queued' || job?.status === 'running';
}

function staleMinutes(job?: Job | null) {
  if (!isActiveJob(job) || !job?.updated_at) return 0;
  return Math.floor((Date.now() / 1000 - job.updated_at) / 60);
}

function staleLabel(job: Job | null | undefined, t: Texts) {
  const minutes = staleMinutes(job);
  if (minutes < 2) return '';
  return `${t.jobs.stalePrefix} ${minutes} ${t.jobs.minutes}`;
}

function qualityRowsFromJob(job?: Job | null) {
  const rows = job?.result?.results;
  return Array.isArray(rows) ? rows as Record<string, string | number | boolean>[] : [];
}

function similarTracksFromJob(job?: Job | null) {
  const tracks = job?.result?.tracks;
  return Array.isArray(tracks) ? tracks.map(String) : [];
}

async function chooseFiles(initialDir?: string, multiple = true) {
  const data = await api<DialogResponse>('/api/dialog/files', {
    method: 'POST',
    body: JSON.stringify({ initialDir, multiple, audioOnly: true })
  });
  return data.paths;
}

async function chooseFolders(initialDir?: string, multiple = true) {
  const data = await api<DialogResponse>('/api/dialog/folders', {
    method: 'POST',
    body: JSON.stringify({ initialDir, multiple })
  });
  return data.paths;
}

function uniqueAppend(current: string[], incoming: string[]) {
  const seen = new Set(current);
  const out = [...current];
  for (const item of incoming.map((x) => x.trim()).filter(Boolean)) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function routeFromLocation() {
  const part = window.location.pathname.split('/').filter(Boolean)[0];
  return part || 'library';
}

function appLanguage(settings?: SettingsState): Language {
  return settings?.ui?.language === 'en' ? 'en' : 'cs';
}

function parentPath(path: string) {
  const clean = path.replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx <= 0 ? '/' : clean.slice(0, idx);
}

function optionString(options: Record<string, unknown> | undefined, key: string) {
  const value = options?.[key];
  return typeof value === 'string' ? value : '';
}

function App() {
  const [route, setRoute] = useState(routeFromLocation());
  const [appState, setAppState] = useState<AppState | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [sets, setSets] = useState<SetsState>({ active_set: 'PREP', sets: [] });
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const language = appLanguage(appState?.settings);
  const t = text[language];

  const refresh = async () => {
    const [state, trackRows, setRows] = await Promise.all([
      api<AppState>('/api/app/state'),
      api<{ tracks: Track[] }>('/api/tracks?limit=1000'),
      api<SetsState>('/api/sets')
    ]);
    setAppState(state);
    setTracks(trackRows.tracks);
    setSets(setRows);
  };

  useEffect(() => {
    refresh().catch((err) => setNotice(errorMessage(err)));
  }, []);

  const navigate = (next: string) => {
    window.history.pushState(null, '', `/${next}`);
    setRoute(next);
  };

  useEffect(() => {
    const onPop = () => setRoute(routeFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const activeSet = useMemo(
    () => sets.sets.find((row) => row.name === sets.active_set) || sets.sets[0],
    [sets]
  );
  const prepTracks = useMemo(() => {
    const ids = new Set(activeSet?.ids || []);
    return tracks.filter((track) => ids.has(track.id));
  }, [activeSet, tracks]);

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">V</div>
          <div>
            <strong>Velyos Deck</strong>
            <span>{t.brandSub}</span>
          </div>
        </div>
        <nav>
          {nav.filter(([key]) => {
            // Online views (download/quality/similar) need a download tool.
            // They are hidden when none is available (e.g. the public release
            // ships without the optional, gitignored downloader module).
            const online = key === 'download' || key === 'quality' || key === 'similar';
            const ts = appState?.toolStatus || {};
            return !online || ts['scdl'] || ts['yt-dlp'] || ts['spotdl'];
          }).map(([key, Icon]) => (
            <button className={route === key ? 'active' : ''} key={key} onClick={() => navigate(key)}>
              <Icon size={18} />
              <span>{t.nav[key]}</span>
            </button>
          ))}
        </nav>
        <div className="tool-status">
          {Object.entries(appState?.toolStatus || {}).map(([name, ok]) => (
            <span className={ok ? 'ok' : 'bad'} key={name}>{name}</span>
          ))}
        </div>
      </aside>

      <main>
        <header className="top">
          <div>
            <h1>{routeTitle(route, t)}</h1>
            <p>{appState ? `${appState.library.tracks} ${t.tracks} · ${appState.library.ready} ${t.ready} · ${sets.active_set}` : t.loadingState}</p>
          </div>
          <div className="top-actions">
            <button className="icon-btn" onClick={() => refresh()} title={t.refresh}>
              <RefreshCcw size={18} />
            </button>
            <a className="primary-action" href="/live">
              <Play size={18} />
              {t.liveDeck}
            </a>
          </div>
        </header>

        {notice && <div className="notice">{notice}</div>}

        {route === 'library' && (
          <LibraryView
            tracks={tracks}
            sets={sets}
            selected={selected}
            setSelected={setSelected}
            prepTracks={prepTracks}
            settings={appState?.settings}
            onRefresh={refresh}
            onNotice={setNotice}
            t={t}
          />
        )}
        {route === 'download' && <DownloadView settings={appState?.settings} onNotice={setNotice} t={t} />}
        {route === 'quality' && <QualityView onNotice={setNotice} t={t} />}
        {route === 'similar' && <SimilarView onNotice={setNotice} t={t} />}
        {route === 'enhance' && <EnhanceView selected={selected} tracks={tracks} settings={appState?.settings} onNotice={setNotice} onRefresh={refresh} t={t} />}
        {route === 'live' && <LiveView onNotice={setNotice} t={t} />}
        {route === 'jobs' && <JobsView initialJobs={appState?.jobs || []} t={t} />}
        {route === 'settings' && <SettingsView settings={appState?.settings} onSaved={refresh} onNotice={setNotice} t={t} />}
      </main>
    </div>
  );
}

function routeTitle(route: string, t: Texts) {
  return t.titles[route as keyof typeof t.titles] || t.titles.library;
}

function LibraryView({
  tracks,
  sets,
  selected,
  setSelected,
  prepTracks,
  settings,
  onRefresh,
  onNotice,
  t
}: {
  tracks: Track[];
  sets: SetsState;
  selected: string[];
  setSelected: (ids: string[]) => void;
  prepTracks: Track[];
  settings?: SettingsState;
  onRefresh: () => Promise<void>;
  onNotice: (value: string) => void;
  t: Texts;
}) {
  const [filter, setFilter] = useState('');
  const [path, setPath] = useState('');
  const [setName, setSetName] = useState(sets.active_set || 'PREP');
  const [roots, setRoots] = useState<FsNode[]>([]);
  const [children, setChildren] = useState<Record<string, FsNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [folderFiles, setFolderFiles] = useState<FsAudioFile[]>([]);
  const [recursive, setRecursive] = useState(false);

  useEffect(() => setSetName(sets.active_set || 'PREP'), [sets.active_set]);

  const loadRoots = async () => {
    const data = await api<{ roots: FsNode[] }>('/api/fs/roots');
    setRoots(data.roots);
  };

  useEffect(() => {
    loadRoots().catch((err) => onNotice(errorMessage(err)));
  }, []);

  const loadChildren = async (node: FsNode) => {
    if (children[node.path]) return;
    const data = await api<{ children: FsNode[] }>(`/api/fs/children?path=${encodeURIComponent(node.path)}`);
    setChildren((current) => ({ ...current, [node.path]: data.children }));
  };

  const loadAudio = async (folder: string, includeNested = recursive) => {
    if (!folder) return;
    const data = await api<{ files: FsAudioFile[] }>(`/api/fs/audio?path=${encodeURIComponent(folder)}&recursive=${includeNested ? 'true' : 'false'}`);
    setFolderFiles(data.files);
    onNotice(`${t.library.folderLoaded}: ${data.files.length}`);
  };

  useEffect(() => {
    if (selectedFolder) {
      loadAudio(selectedFolder, recursive).catch((err) => onNotice(errorMessage(err)));
    }
  }, [recursive]);

  const toggleNode = async (node: FsNode) => {
    if (node.hasChildren) await loadChildren(node);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

  const selectFolder = async (node: FsNode) => {
    setSelectedFolder(node.path);
    if (node.hasChildren) await loadChildren(node);
    await loadAudio(node.path);
  };

  const baseRows = useMemo(() => {
    if (!selectedFolder) return tracks;
    return tracks.filter((track) => {
      const parent = parentPath(track.path);
      return recursive ? track.path.startsWith(`${selectedFolder.replace(/\/+$/, '')}/`) : parent === selectedFolder;
    });
  }, [tracks, selectedFolder, recursive]);

  const displayRows: LibraryRow[] = useMemo(() => {
    const byPath = new Map(baseRows.map((track) => [track.path, track]));
    const importedRows = baseRows.map((track) => ({
      key: track.id,
      path: track.path,
      title: track.title || track.path.split('/').pop() || track.path,
      artist: track.artist,
      bpm: track.bpm,
      keyName: track.key,
      camelot: track.camelot,
      energy: track.energy,
      trackId: track.id,
      imported: true
    }));
    if (!selectedFolder) return importedRows;
    const fileRows = folderFiles
      .filter((file) => !byPath.has(file.path))
      .map((file) => ({
        key: file.path,
        path: file.path,
        title: file.name,
        artist: '',
        imported: false
      }));
    return [...importedRows, ...fileRows];
  }, [baseRows, folderFiles, selectedFolder]);

  const filtered = displayRows.filter((row) =>
    `${row.title} ${row.artist} ${row.path} ${row.camelot || ''}`.toLowerCase().includes(filter.toLowerCase())
  );

  const selectableIds = filtered.map((row) => row.trackId).filter((id): id is string => Boolean(id));

  const toggleTrack = (id?: string) => {
    if (!id) return;
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const addTrack = async () => {
    if (!path.trim()) return;
    try {
      await api('/api/tracks', { method: 'POST', body: JSON.stringify({ path }) });
      setPath('');
      await onRefresh();
    } catch (error) {
      onNotice(errorMessage(error));
    }
  };

  const importInputs = async (paths: string[] = [], folders: string[] = []) => {
    if (!paths.length && !folders.length) return;
    try {
      const data = await api<ImportResponse>('/api/tracks/import', {
        method: 'POST',
        body: JSON.stringify({ paths, folders, recursive: true })
      });
      onNotice(`${t.library.importedCount} ${data.count}${data.skipped.length ? ` · ${t.library.skipped} ${data.skipped.length}` : ''}`);
      await onRefresh();
      if (selectedFolder) await loadAudio(selectedFolder);
    } catch (error) {
      onNotice(errorMessage(error));
    }
  };

  const addFiles = async () => {
    try {
      const paths = await chooseFiles(settings?.destination, true);
      await importInputs(paths, []);
    } catch (error) {
      onNotice(`${t.library.pickerFailed}: ${errorMessage(error)}`);
    }
  };

  const addFolder = async () => {
    try {
      const folders = await chooseFolders(settings?.destination, true);
      await importInputs([], folders);
    } catch (error) {
      onNotice(`${t.library.pickerFailed}: ${errorMessage(error)}`);
    }
  };

  const savePrep = async () => {
    const ids = selected.length ? selected : prepTracks.map((track) => track.id);
    await api('/api/sets', { method: 'POST', body: JSON.stringify({ name: setName || 'PREP', ids }) });
    onNotice(`${t.library.setSaved}: ${setName || 'PREP'} (${ids.length})`);
    await onRefresh();
  };

  const analyzeSelected = async () => {
    if (!selected.length) return;
    const job = await api<{ id: string }>('/api/jobs/analyze', {
      method: 'POST',
      body: JSON.stringify({ trackIds: selected })
    });
    onNotice(`${t.library.analyze}: ${job.id}`);
  };

  const analyzeFolder = async () => {
    if (!selectedFolder) return;
    const job = await api<{ id: string }>('/api/jobs/analyze', {
      method: 'POST',
      body: JSON.stringify({ folders: [selectedFolder], recursive })
    });
    onNotice(`${t.library.analyze}: ${job.id}`);
  };

  const stemsSelected = async () => {
    if (!selected.length) return;
    const job = await api<{ id: string }>('/api/jobs/stems', {
      method: 'POST',
      body: JSON.stringify({ trackIds: selected })
    });
    onNotice(`${t.library.stems}: ${job.id}`);
  };

  return (
    <section className="workspace library-browser">
      <div className="toolbar span-2">
        <div className="field search">
          <Search size={17} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t.library.filter} />
        </div>
        <div className="field path-field">
          <Plus size={17} />
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t.library.manualPath} />
        </div>
        <button onClick={addTrack}><Plus size={17} />{t.common.add}</button>
        <button onClick={addFiles}><FileMusic size={17} />{t.common.files}</button>
        <button onClick={addFolder}><FolderOpen size={17} />{t.common.folder}</button>
        <button onClick={() => setSelected(selectableIds)} disabled={!selectableIds.length}>
          <CheckSquare size={17} />{t.library.selectFiltered}
        </button>
        <button onClick={() => setSelected([])} disabled={!selected.length}><Trash2 size={17} />{t.common.clear}</button>
        <button onClick={analyzeSelected} disabled={!selected.length}><AudioLines size={17} />{t.library.analyze}</button>
        <button onClick={stemsSelected} disabled={!selected.length}><SlidersHorizontal size={17} />{t.library.stems}</button>
      </div>

      <aside className="folder-panel">
        <div className="panel-head">
          <div>
            <h2>{t.library.folderTree}</h2>
            <span>{t.library.folderHint}</span>
          </div>
          <button className="icon-btn" onClick={() => loadRoots().catch((err) => onNotice(errorMessage(err)))} title={t.refresh}>
            <RefreshCcw size={17} />
          </button>
        </div>
        <FolderTree
          nodes={roots}
          children={children}
          expanded={expanded}
          selectedPath={selectedFolder}
          onToggle={(node) => toggleNode(node).catch((err) => onNotice(errorMessage(err)))}
          onSelect={(node) => selectFolder(node).catch((err) => onNotice(errorMessage(err)))}
        />
      </aside>

      <div className="library-main">
        <div className="toolbar library-folder-actions">
          <div className="folder-current">
            <strong>{selectedFolder ? t.library.currentFolder : t.library.allTracks}</strong>
            <span>{selectedFolder || `${tracks.length} ${t.tracks}`}</span>
          </div>
          <label className="inline-check">
            <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
            {t.library.showRecursive}
          </label>
          <button onClick={() => selectedFolder && importInputs([], [selectedFolder])} disabled={!selectedFolder}>
            <FolderOpen size={17} />{t.library.importFolder}
          </button>
          <button onClick={analyzeFolder} disabled={!selectedFolder}>
            <AudioLines size={17} />{t.library.analyzeFolder}
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>{t.library.title}</th>
                <th>{t.library.artist}</th>
                <th>{t.library.bpm}</th>
                <th>{t.library.key}</th>
                <th>{t.library.camelot}</th>
                <th>{t.library.energy}</th>
                <th>{t.library.source}</th>
                <th>{t.library.path}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.key} className={row.trackId && selected.includes(row.trackId) ? 'selected' : ''} onClick={() => toggleTrack(row.trackId)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={Boolean(row.trackId && selected.includes(row.trackId))}
                      disabled={!row.trackId}
                      onChange={() => toggleTrack(row.trackId)}
                    />
                  </td>
                  <td>{row.title}</td>
                  <td>{row.artist || '-'}</td>
                  <td className="num">{row.bpm || '-'}</td>
                  <td>{row.keyName || '-'}</td>
                  <td><span className={row.camelot ? 'camelot' : 'muted'}>{row.camelot || '?'}</span></td>
                  <td>{row.energy || '-'}</td>
                  <td><span className={`source-pill ${row.imported ? 'imported' : ''}`}>{row.imported ? t.common.imported : t.common.notImported}</span></td>
                  <td className="path">{row.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && <div className="empty small">{selectedFolder ? t.library.noAudio : t.library.noTracks}</div>}
        </div>
      </div>

      <aside className="prep-panel">
        <div className="panel-head">
          <div>
            <h2>{t.library.prep}</h2>
            <span>{prepTracks.length} {t.library.prepCount}</span>
          </div>
          <button className="icon-btn" onClick={savePrep} title={t.common.save}>
            <ListMusic size={18} />
          </button>
        </div>
        <div className="field">
          <input value={setName} onChange={(e) => setSetName(e.target.value)} />
        </div>
        <div className="set-list">
          {sets.sets.map((set) => (
            <button
              key={set.name}
              className={set.name === sets.active_set ? 'active' : ''}
              onClick={async () => {
                await api(`/api/sets/${encodeURIComponent(set.name)}/load`, { method: 'POST' });
                await onRefresh();
              }}
            >
              <span>{set.name}</span>
              <b>{set.count}</b>
            </button>
          ))}
        </div>
        <ol className="prep-list">
          {prepTracks.map((track) => (
            <li key={track.id}>
              <span>{track.title}</span>
              <em>{track.bpm || '-'} · {track.camelot || '?'}</em>
            </li>
          ))}
        </ol>
      </aside>
    </section>
  );
}

function FolderTree({
  nodes,
  children,
  expanded,
  selectedPath,
  onToggle,
  onSelect,
  depth = 0
}: {
  nodes: FsNode[];
  children: Record<string, FsNode[]>;
  expanded: Set<string>;
  selectedPath: string;
  onToggle: (node: FsNode) => void;
  onSelect: (node: FsNode) => void;
  depth?: number;
}) {
  return (
    <div className="folder-tree">
      {nodes.map((node) => {
        const isOpen = expanded.has(node.path);
        const nested = children[node.path] || [];
        return (
          <div key={node.path}>
            <div className={`folder-node ${selectedPath === node.path ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 18 }}>
              <button className="tree-toggle" onClick={() => onToggle(node)} disabled={!node.hasChildren}>
                {node.hasChildren ? (isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />) : <span />}
              </button>
              <button className="tree-label" onClick={() => onSelect(node)}>
                {node.kind === 'volumes' ? <HardDrive size={17} /> : <FolderOpen size={17} />}
                <span>{node.name}</span>
                {node.audioCount > 0 && <b>{node.audioCount}</b>}
              </button>
            </div>
            {isOpen && nested.length > 0 && (
              <FolderTree nodes={nested} children={children} expanded={expanded} selectedPath={selectedPath} onToggle={onToggle} onSelect={onSelect} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function DownloadView({ settings, onNotice, t }: { settings?: SettingsState; onNotice: (value: string) => void; t: Texts }) {
  const [items, setItems] = useState('');
  const [destination, setDestination] = useState(settings?.destination || '');
  const [quality, setQuality] = useState(settings?.quality || 'best');
  const [jobName, setJobName] = useState('');

  useEffect(() => {
    setDestination(settings?.destination || '');
    setQuality(settings?.quality || 'best');
  }, [settings]);

  const start = async () => {
    const job = await api<{ id: string }>('/api/jobs/download', {
      method: 'POST',
      body: JSON.stringify({ jobName, items: items.split('\n'), destination, quality })
    });
    onNotice(`${t.download.started}: ${job.id}`);
  };

  const pickDestination = async () => {
    try {
      const folders = await chooseFolders(destination || settings?.destination, false);
      if (folders[0]) setDestination(folders[0]);
    } catch (error) {
      onNotice(errorMessage(error));
    }
  };

  return (
    <section className="workspace form-grid">
      <div className="module wide">
        <h2>{t.download.queue}</h2>
        <label className="field-label">{t.download.jobName}</label>
        <input value={jobName} onChange={(e) => setJobName(e.target.value)} placeholder={t.download.jobNamePlaceholder} />
        <textarea value={items} onChange={(e) => setItems(e.target.value)} placeholder={t.download.placeholder} />
        <div className="form-row">
          <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder={t.download.destination} />
          <button onClick={pickDestination}><FolderOpen size={17} />{t.common.folder}</button>
          <select value={quality} onChange={(e) => setQuality(e.target.value)}>
            <option value="best">best</option>
            <option value="mp3-320">mp3-320</option>
            <option value="flac">flac</option>
            <option value="opus">opus</option>
          </select>
          <button className="primary-action" onClick={start}><Download size={18} />{t.common.start}</button>
        </div>
      </div>
    </section>
  );
}

function QualityView({ onNotice, t }: { onNotice: (value: string) => void; t: Texts }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Record<string, string | number | boolean>[]>([]);
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    const jobId = job?.id;
    if (!jobId || !isActiveJob(job)) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const next = await api<Job>(`/api/jobs/${jobId}`);
        if (!active) return;
        setJob(next);
        if (next.status === 'done') {
          const nextRows = qualityRowsFromJob(next);
          setRows(nextRows);
          onNotice(`${t.quality.done}: ${nextRows.length}`);
        } else if (next.status === 'error') {
          onNotice(`${t.quality.failed}: ${next.error || next.message}`);
        } else if (next.status === 'cancelled') {
          onNotice(`${t.jobs.cancel}: ${next.id}`);
        }
      } catch (error) {
        if (active) onNotice(errorMessage(error));
      }
    };
    const timer = window.setInterval(poll, 1500);
    void poll();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status, onNotice, t.quality.done, t.quality.failed, t.jobs.cancel]);

  const run = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      onNotice(t.quality.empty);
      return;
    }
    try {
      setRows([]);
      const started = await api<{ id: string }>('/api/jobs/quality', {
        method: 'POST',
        body: JSON.stringify({ query: trimmed })
      });
      const next = await api<Job>(`/api/jobs/${started.id}`);
      setJob(next);
      onNotice(`${t.quality.started}: ${started.id}`);
    } catch (error) {
      onNotice(errorMessage(error));
    }
  };
  const cancel = async () => {
    if (!job) return;
    const cancelled = await api<Job>(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    setJob(cancelled);
    onNotice(`${t.jobs.cancel}: ${cancelled.id}`);
  };
  return (
    <section className="workspace">
      <div className="toolbar">
        <div className="field search"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.quality.placeholder} /></div>
        <button onClick={run} disabled={isActiveJob(job)}><Gauge size={17} />{t.quality.probe}</button>
        {isActiveJob(job) && <button className="danger-action" onClick={cancel}><StopCircle size={17} />{t.quality.cancel}</button>}
      </div>
      {job && (
        <div className="job-status-panel">
          <div><strong>{job.name || job.id}</strong><span className={`status ${job.status}`}>{job.status}</span></div>
          <progress max="100" value={job.progress || 0} />
          <p>{job.error || job.message}</p>
          {staleLabel(job, t) && <p className="warning-text">{staleLabel(job, t)}</p>}
        </div>
      )}
      <ResultTable rows={rows} />
    </section>
  );
}

function SimilarView({ onNotice, t }: { onNotice: (value: string) => void; t: Texts }) {
  const [seed, setSeed] = useState('');
  const [rows, setRows] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    const jobId = job?.id;
    if (!jobId || !isActiveJob(job)) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const next = await api<Job>(`/api/jobs/${jobId}`);
        if (!active) return;
        setJob(next);
        if (next.status === 'done') {
          const tracks = similarTracksFromJob(next);
          setRows(tracks);
          onNotice(`${t.similar.done}: ${tracks.length}`);
        } else if (next.status === 'error') {
          onNotice(`${t.similar.failed}: ${next.error || next.message}`);
        } else if (next.status === 'cancelled') {
          onNotice(`${t.jobs.cancel}: ${next.id}`);
        }
      } catch (error) {
        if (active) onNotice(errorMessage(error));
      }
    };
    const timer = window.setInterval(poll, 1500);
    void poll();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status, onNotice, t.similar.done, t.similar.failed, t.jobs.cancel]);

  const run = async () => {
    const trimmed = seed.trim();
    if (!trimmed) {
      onNotice(t.similar.empty);
      return;
    }
    try {
      setRows([]);
      const started = await api<{ id: string }>('/api/jobs/similar', {
        method: 'POST',
        body: JSON.stringify({ seed: trimmed, limit: 20 })
      });
      const next = await api<Job>(`/api/jobs/${started.id}`);
      setJob(next);
      onNotice(`${t.similar.started}: ${started.id}`);
    } catch (error) {
      onNotice(errorMessage(error));
    }
  };
  const cancel = async () => {
    if (!job) return;
    const cancelled = await api<Job>(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    setJob(cancelled);
    onNotice(`${t.jobs.cancel}: ${cancelled.id}`);
  };
  return (
    <section className="workspace">
      <div className="toolbar">
        <div className="field search"><Sparkles size={17} /><input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder={t.similar.placeholder} /></div>
        <button onClick={run} disabled={isActiveJob(job)}><Search size={17} />{t.similar.find}</button>
        {isActiveJob(job) && <button className="danger-action" onClick={cancel}><StopCircle size={17} />{t.similar.cancel}</button>}
      </div>
      {job && (
        <div className="job-status-panel">
          <div><strong>{job.name || job.id}</strong><span className={`status ${job.status}`}>{job.status}</span></div>
          <progress max="100" value={job.progress || 0} />
          <p>{job.error || job.message}</p>
          {staleLabel(job, t) && <p className="warning-text">{staleLabel(job, t)}</p>}
        </div>
      )}
      <ol className="result-list">{rows.map((row) => <li key={row}>{row}</li>)}</ol>
    </section>
  );
}

function EnhanceView({
  selected,
  tracks,
  settings,
  onNotice,
  onRefresh,
  t
}: {
  selected: string[];
  tracks: Track[];
  settings?: SettingsState;
  onNotice: (value: string) => void;
  onRefresh: () => Promise<void>;
  t: Texts;
}) {
  const [mode, setMode] = useState(settings?.enhanceMode === 'club' ? 'club' : 'manual');
  const [opts, setOpts] = useState({ denoise: false, brightness: true, stereo_widen: false, loudnorm: true });
  const [paths, setPaths] = useState<string[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [recursive, setRecursive] = useState(true);
  const [manualPath, setManualPath] = useState('');
  const [jobName, setJobName] = useState('');
  const [analyzeJob, setAnalyzeJob] = useState<Job | null>(null);
  const [recentJob, setRecentJob] = useState<Job | null>(null);
  const selectedTracks = tracks.filter((track) => selected.includes(track.id));
  const totalInputs = selected.length + paths.length + folders.length;
  const optionDescriptions: Record<keyof typeof opts, string> = {
    denoise: t.enhance.denoise,
    brightness: t.enhance.brightness,
    stereo_widen: t.enhance.stereo_widen,
    loudnorm: t.enhance.loudnorm
  };

  useEffect(() => {
    setMode(settings?.enhanceMode === 'club' ? 'club' : 'manual');
  }, [settings?.enhanceMode]);

  const addFiles = async () => {
    try {
      const chosen = await chooseFiles(settings?.destination, true);
      setPaths((current) => uniqueAppend(current, chosen));
    } catch (error) {
      onNotice(errorMessage(error));
    }
  };

  const addFolders = async () => {
    try {
      const chosen = await chooseFolders(settings?.destination, true);
      setFolders((current) => uniqueAppend(current, chosen));
    } catch (error) {
      onNotice(errorMessage(error));
    }
  };

  const addManual = () => {
    const entries = manualPath.split('\n').map((line) => line.trim()).filter(Boolean);
    setPaths((current) => uniqueAppend(current, entries));
    setManualPath('');
  };

  const payload = () => ({ jobName, trackIds: selected, paths, folders, recursive, mode, options: mode === 'manual' ? opts : {} });

  useEffect(() => {
    const jobId = analyzeJob?.id;
    if (!jobId || !isActiveJob(analyzeJob)) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const job = await api<Job>(`/api/jobs/${jobId}`);
        if (!active) return;
        setAnalyzeJob(job);
        if (job.status === 'done') {
          await onRefresh();
          onNotice(`${t.enhance.done}: ${job.id}`);
        } else if (job.status === 'error') {
          onNotice(`${t.enhance.failed}: ${job.id}`);
        }
      } catch (error) {
        if (active) onNotice(errorMessage(error));
      }
    };
    const timer = window.setInterval(poll, 1500);
    void poll();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [analyzeJob?.id, analyzeJob?.status, onNotice, onRefresh, t.enhance.done, t.enhance.failed]);

  useEffect(() => {
    const jobId = recentJob?.id;
    if (!jobId || !isActiveJob(recentJob)) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const job = await api<Job>(`/api/jobs/${jobId}`);
        if (!active) return;
        setRecentJob(job);
        if (job.status === 'done') {
          await onRefresh();
          onNotice(`${job.kind}: ${job.id} done`);
        } else if (job.status === 'error' || job.status === 'cancelled') {
          onNotice(`${job.kind}: ${job.id} ${job.status}`);
        }
      } catch (error) {
        if (active) onNotice(errorMessage(error));
      }
    };
    const timer = window.setInterval(poll, 1500);
    void poll();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [recentJob?.id, recentJob?.status, onNotice, onRefresh]);

  const cancelVisibleJob = async (job: Job) => {
    const cancelled = await api<Job>(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    if (analyzeJob?.id === cancelled.id) setAnalyzeJob(cancelled);
    if (recentJob?.id === cancelled.id) setRecentJob(cancelled);
    onNotice(`${t.jobs.cancel}: ${cancelled.id}`);
  };

  const startEnhance = async () => {
    const job = await api<{ id: string }>('/api/jobs/enhance', {
      method: 'POST',
      body: JSON.stringify(payload())
    });
    setRecentJob({ id: job.id, name: jobName, kind: 'enhance', status: 'queued', progress: 0, message: 'queued', created_at: Date.now() / 1000, updated_at: Date.now() / 1000 });
    onNotice(`${t.enhance.enhanceAction}: ${job.id}`);
  };

  const startAnalyze = async () => {
    const job = await api<{ id: string }>('/api/jobs/analyze', {
      method: 'POST',
      body: JSON.stringify(payload())
    });
    setAnalyzeJob({ id: job.id, name: jobName, kind: 'analyze', status: 'queued', progress: 0, message: 'queued', created_at: Date.now() / 1000, updated_at: Date.now() / 1000 });
    onNotice(`${t.enhance.analyzeAction}: ${job.id}`);
  };

  const startStems = async () => {
    const job = await api<{ id: string }>('/api/jobs/stems', {
      method: 'POST',
      body: JSON.stringify(payload())
    });
    setRecentJob({ id: job.id, name: jobName, kind: 'stems', status: 'queued', progress: 0, message: 'queued', created_at: Date.now() / 1000, updated_at: Date.now() / 1000 });
    onNotice(`${t.enhance.stemsAction}: ${job.id}`);
  };

  return (
    <section className="workspace form-grid">
      <div className="module">
        <h2>{t.enhance.mode}</h2>
        <label className="field-label">{t.enhance.jobName}</label>
        <input value={jobName} onChange={(e) => setJobName(e.target.value)} placeholder={t.enhance.jobNamePlaceholder} />
        <div className="segmented">
          <button className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>{t.enhance.manual}</button>
          <button className={mode === 'club' ? 'active' : ''} onClick={() => setMode('club')}>{t.enhance.club}</button>
        </div>
        <p className="help-text"><strong>{mode === 'manual' ? t.enhance.manual : t.enhance.club}</strong> {mode === 'manual' ? t.enhance.manualHelp : t.enhance.clubHelp}</p>
        {mode === 'manual' ? (
          <div className="mode-panel">
            <h2>{t.enhance.manualFilters}</h2>
            {Object.entries(opts).map(([key, value]) => (
              <label className="check" key={key}>
                <input type="checkbox" checked={value} onChange={(e) => setOpts({ ...opts, [key]: e.target.checked })} />
                <span>
                  <strong>{key}</strong>
                  <em>{optionDescriptions[key as keyof typeof opts]}</em>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="mode-panel club-preset">
            <h2>{t.enhance.clubPreset}</h2>
            <ul>
              {t.enhance.clubPresetItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        )}
        <button className="primary-action" onClick={startEnhance} disabled={!totalInputs}>
          <Wand2 size={18} />{t.enhance.enhanceAction} {totalInputs}
        </button>
        <p className="help-text">{t.enhance.enhanceHelp}</p>
        <button onClick={startAnalyze} disabled={!totalInputs}><AudioLines size={17} />{t.enhance.analyzeAction}</button>
        <p className="help-text">{t.enhance.analyzeHelp}</p>
        <button onClick={startStems} disabled={!totalInputs}><SlidersHorizontal size={17} />{t.enhance.stemsAction}</button>
        <p className="help-text">{t.enhance.stemsHelp}</p>
        <JobStatusPanel job={analyzeJob} recentJob={recentJob} onRefresh={onRefresh} onCancel={cancelVisibleJob} t={t} />
      </div>
      <div className="module wide">
        <div className="panel-head">
          <div>
            <h2>{t.enhance.inputs}</h2>
            <span>{selected.length} library · {paths.length} {t.common.files.toLowerCase()} · {folders.length} {t.common.folders.toLowerCase()}</span>
            <p className="help-text">{t.enhance.libraryInput}</p>
          </div>
          <div className="button-row">
            <button onClick={addFiles}><FileMusic size={17} />{t.enhance.chooseFiles}</button>
            <button onClick={addFolders}><FolderOpen size={17} />{t.enhance.chooseFolders}</button>
          </div>
        </div>
        <p className="help-text">{t.enhance.pickerHelp}</p>
        <label className="inline-check enhance-recursive">
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          <span>
            <strong>{t.enhance.includeSubfolders}</strong>
            <em>{recursive ? t.enhance.folderRecursiveOn : t.enhance.folderRecursiveOff}</em>
          </span>
        </label>
        <div className="manual-path-row">
          <textarea
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            placeholder="/Users/.../track.wav"
          />
          <button onClick={addManual} disabled={!manualPath.trim()}><Plus size={17} />{t.common.add}</button>
        </div>
        <p className="help-text">{t.enhance.manualPathsHelp}</p>
        <h2>{t.enhance.librarySelection}</h2>
        <p className="help-text">{t.enhance.librarySelectionHelp}</p>
        <ol className="result-list compact">{selectedTracks.map((track) => <li key={track.id}>{track.title}</li>)}</ol>
        <PathList title={t.common.files} help={t.enhance.fileListHelp} items={paths} onRemove={(path) => setPaths(paths.filter((item) => item !== path))} t={t} />
        <PathList title={t.common.folders} help={t.enhance.folderListHelp} items={folders} onRemove={(path) => setFolders(folders.filter((item) => item !== path))} t={t} />
      </div>
    </section>
  );
}

function JobStatusPanel({
  job,
  recentJob,
  onRefresh,
  onCancel,
  t
}: {
  job: Job | null;
  recentJob: Job | null;
  onRefresh: () => Promise<void>;
  onCancel: (job: Job) => Promise<void>;
  t: Texts;
}) {
  const displayJob = job || recentJob;
  const stale = staleLabel(displayJob, t);
  return (
    <div className="job-status-panel">
      <div className="panel-head compact-head">
        <div>
          <h2>{t.enhance.statusTitle}</h2>
          <span>{job ? t.enhance.polling : t.enhance.noAnalyze}</span>
        </div>
        <div className="button-row">
          {displayJob && isActiveJob(displayJob) && (
            <button className="danger-button" onClick={() => void onCancel(displayJob)}><StopCircle size={17} />{t.enhance.cancelJob}</button>
          )}
          <button onClick={() => void onRefresh()}><RefreshCcw size={17} />{t.enhance.refreshLibrary}</button>
        </div>
      </div>
      {!displayJob ? (
        <div className="empty small">{t.enhance.startAnalyze}</div>
      ) : (
        <div className="job-details">
          {stale && <div className="stale-warning">{stale}</div>}
          <div className="job-row">
            <span className={`status ${displayJob.status}`}>{displayJob.status}</span>
            <strong>{displayJob.kind}</strong>
          </div>
          <progress value={Math.max(0, Math.min(100, Number(displayJob.progress) || 0))} max={100} />
          <dl>
            <div><dt>{t.jobs.name}</dt><dd>{displayJob.name || t.jobs.unnamed}</dd></div>
            <div><dt>{t.enhance.jobId}</dt><dd>{displayJob.id}</dd></div>
            <div><dt>{t.enhance.message}</dt><dd>{displayJob.error || displayJob.message || t.enhance.waiting}</dd></div>
          </dl>
        </div>
      )}
    </div>
  );
}

function PathList({ title, help, items, onRemove, t }: { title: string; help: string; items: string[]; onRemove: (item: string) => void; t: Texts }) {
  return (
    <div className="path-list-block">
      <h2>{title}</h2>
      <p className="help-text">{help}</p>
      {!items.length ? <div className="empty small">{t.common.noneSelected}</div> : (
        <ol className="path-list">
          {items.map((item) => (
            <li key={item}>
              <span>{item}</span>
              <button className="icon-btn" onClick={() => onRemove(item)} title={t.common.remove}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function LiveView({ onNotice, t }: { onNotice: (value: string) => void; t: Texts }) {
  const [status, setStatus] = useState('idle');
  const call = async (action: 'start' | 'refresh' | 'stop') => {
    const res = await api<{ status: string; tracks?: number }>(`/api/live/${action}`, { method: 'POST' });
    setStatus(`${res.status}${typeof res.tracks === 'number' ? ` · ${res.tracks} ${t.tracks}` : ''}`);
    onNotice(`Live ${action}: ${res.status}`);
  };
  return (
    <section className="workspace live-launch">
      <div className="live-band">
        <Music2 size={32} />
        <div>
          <h2>{t.live.wrapper}</h2>
          <p>{status}</p>
        </div>
        <button onClick={() => call('start')}><Play size={17} />{t.live.start}</button>
        <button onClick={() => call('refresh')}><RefreshCcw size={17} />{t.live.refresh}</button>
        <a className="primary-action" href="/live"><SlidersHorizontal size={18} />{t.live.open}</a>
      </div>
    </section>
  );
}

function JobsView({ initialJobs, t }: { initialJobs: Job[]; t: Texts }) {
  const [jobs, setJobs] = useState(initialJobs);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const refreshJobs = () => api<{ jobs: Job[] }>('/api/jobs').then((data) => setJobs(data.jobs)).catch(() => undefined);
  const cancelJob = async (job: Job) => {
    await api<Job>(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    await refreshJobs();
  };
  const repeatJob = async (job: Job) => {
    await api<{ id: string }>(`/api/jobs/${job.id}/repeat`, { method: 'POST' });
    await refreshJobs();
  };
  const saveJobName = async (job: Job) => {
    const renamed = await api<Job>(`/api/jobs/${job.id}/name`, {
      method: 'PUT',
      body: JSON.stringify({ name: nameDrafts[job.id] ?? '' })
    });
    setJobs((current) => current.map((item) => item.id === renamed.id ? renamed : item));
  };

  useEffect(() => {
    setJobs(initialJobs);
  }, [initialJobs]);

  useEffect(() => {
    setNameDrafts((current) => {
      const next = { ...current };
      for (const job of jobs) {
        if (!(job.id in next)) next[job.id] = job.name || '';
      }
      return next;
    });
  }, [jobs]);

  useEffect(() => {
    refreshJobs();
  }, []);

  useEffect(() => {
    if (!jobs.some((job) => job.status === 'queued' || job.status === 'running')) return undefined;
    const timer = window.setInterval(refreshJobs, 1500);
    return () => window.clearInterval(timer);
  }, [jobs]);

  return (
    <section className="workspace">
      <div className="toolbar">
        <button onClick={refreshJobs}><RefreshCcw size={17} />{t.jobs.refresh}</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{t.jobs.id}</th><th>{t.jobs.name}</th><th>{t.jobs.kind}</th><th>{t.jobs.status}</th><th>{t.jobs.progress}</th><th>{t.jobs.message}</th><th>{t.jobs.actions}</th></tr></thead>
          <tbody>{jobs.map((job) => (
            <tr key={job.id}>
              <td>{job.id}</td>
              <td>
                <div className="job-name-cell">
                  <input
                    value={nameDrafts[job.id] ?? job.name ?? ''}
                    onChange={(e) => setNameDrafts({ ...nameDrafts, [job.id]: e.target.value })}
                    placeholder={t.jobs.unnamed}
                  />
                  <button className="compact-action" onClick={() => void saveJobName(job)} title={t.jobs.saveName}><CheckSquare size={16} /></button>
                </div>
                {job.repeated_from && <small>repeat: {job.repeated_from}</small>}
              </td>
              <td>{job.kind}</td>
              <td><span className={`status ${job.status}`}>{job.status}</span></td>
              <td><progress value={job.progress} max={100} /></td>
              <td>
                {staleLabel(job, t) && <div className="stale-warning table-warning">{staleLabel(job, t)}</div>}
                {job.error || job.message}
              </td>
              <td>
                <div className="job-actions">
                  <button className="compact-action" onClick={() => void repeatJob(job)}><RotateCcw size={16} />{t.jobs.repeat}</button>
                  {isActiveJob(job) ? (
                    <button className="danger-button compact-action" onClick={() => void cancelJob(job)}><StopCircle size={16} />{t.jobs.cancel}</button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function SettingsView({ settings, onSaved, onNotice, t }: { settings?: SettingsState; onSaved: () => Promise<void>; onNotice: (value: string) => void; t: Texts }) {
  const [draft, setDraft] = useState<SettingsState | undefined>(settings);
  useEffect(() => setDraft(settings), [settings]);
  if (!draft) return <section className="workspace">{t.loadingState}</section>;
  const language = appLanguage(draft);
  const options = draft.options || {};
  const configured = (options._configured || {}) as Record<string, boolean>;
  const updateOptions = (patch: Record<string, unknown>) => setDraft({ ...draft, options: { ...options, ...patch } });
  const setLanguage = (next: Language) => setDraft({ ...draft, ui: { ...(draft.ui || {}), language: next } });
  const save = async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(draft) });
    await onSaved();
    onNotice(t.settings.saved);
  };
  const pickDestination = async () => {
    try {
      const folders = await chooseFolders(draft.destination, false);
      if (folders[0]) setDraft({ ...draft, destination: folders[0] });
    } catch (error) {
      onNotice(errorMessage(error));
    }
  };
  const scConfigured = Boolean(configured.token || optionString(options, 'token'));
  const spotifyConfigured = Boolean(optionString(options, 'spotifyClientId'));
  const tidalConfigured = Boolean(optionString(options, 'tidalClientId'));
  return (
    <section className="workspace form-grid settings-grid">
      <div className="module">
        <h2>{t.settings.localDefaults}</h2>
        <label>{t.settings.destination}
          <div className="inline-field">
            <input value={draft.destination} onChange={(e) => setDraft({ ...draft, destination: e.target.value })} />
            <button onClick={pickDestination}><FolderOpen size={17} />{t.common.folder}</button>
          </div>
        </label>
        <label>{t.settings.quality}
          <select value={draft.quality} onChange={(e) => setDraft({ ...draft, quality: e.target.value })}>
            <option value="best">best</option>
            <option value="mp3-320">mp3-320</option>
            <option value="flac">flac</option>
            <option value="opus">opus</option>
          </select>
        </label>
        <h2>{t.settings.language}</h2>
        <div className="segmented">
          <button className={language === 'cs' ? 'active' : ''} onClick={() => setLanguage('cs')}><Languages size={16} />{t.settings.czech}</button>
          <button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}><Languages size={16} />{t.settings.english}</button>
        </div>
        <button className="primary-action" onClick={save}><Settings size={18} />{t.common.save}</button>
      </div>

      <div className="module">
        <h2>{t.settings.connections}</h2>
        <p className="help-text">{t.settings.connectionsHelp}</p>
        <ServiceField
          title="SoundCloud"
          label={t.settings.scToken}
          help={t.settings.scHelp}
          value={optionString(options, 'token')}
          configured={scConfigured}
          configuredText={t.settings.configured}
          emptyText={t.settings.notConfigured}
          secret
          onChange={(value) => updateOptions({ token: value })}
        />
        <ServiceField
          title="Spotify"
          label={t.settings.spotifyClient}
          help={t.settings.spotifyHelp}
          value={optionString(options, 'spotifyClientId')}
          configured={spotifyConfigured}
          configuredText={t.settings.configured}
          emptyText={t.settings.notConfigured}
          onChange={(value) => updateOptions({ spotifyClientId: value })}
        />
        <ServiceField
          title="TIDAL"
          label={t.settings.tidalClient}
          help={t.settings.tidalHelp}
          value={optionString(options, 'tidalClientId')}
          configured={tidalConfigured}
          configuredText={t.settings.configured}
          emptyText={t.settings.notConfigured}
          onChange={(value) => updateOptions({ tidalClientId: value })}
        />
      </div>
    </section>
  );
}

function ServiceField({
  title,
  label,
  help,
  value,
  configured,
  configuredText,
  emptyText,
  secret = false,
  onChange
}: {
  title: string;
  label: string;
  help: string;
  value: string;
  configured: boolean;
  configuredText: string;
  emptyText: string;
  secret?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="service-card">
      <div className="service-head">
        <strong>{title}</strong>
        <span className={`status ${configured ? 'done' : 'queued'}`}>{configured ? configuredText : emptyText}</span>
      </div>
      <label>{label}
        <div className="field">
          <KeyRound size={16} />
          <input type={secret ? 'password' : 'text'} value={value} onChange={(e) => onChange(e.target.value)} />
        </div>
      </label>
      <p className="help-text">{help}</p>
    </div>
  );
}

function ResultTable({ rows }: { rows: Record<string, string | number | boolean>[] }) {
  if (!rows.length) return <div className="empty">No results</div>;
  const keys = Object.keys(rows[0]);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{keys.map((key) => <th key={key}>{key}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) => (
          <tr key={i}>{keys.map((key) => <td key={key}>{String(row[key] ?? '')}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
