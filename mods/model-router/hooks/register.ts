// model-router : choisit le modèle et l'effort de chaque tour selon le message envoyé.
//
// Comment ça marche :
//  1. `prompt.submit` : on classe le message (classify.ts) et on retient la décision.
//  2. `turn.step`     : à chaque requête modèle du fil principal, on remplace
//                       `model` et `effort` par ceux de la décision.
//  3. `turn.complete` / `tool.call` : on note les échecs pour l'escalade.
//  4. `/router …`     : on|off, lock, unlock, status, stats, config.
//
// En cas d'erreur, aucune décision n'est appliquée : le tour part avec votre
// réglage actuel (/model et effort de la session), sans jamais bloquer l'envoi.

import type { EngineInterface, Register } from 'claude-code'

import {
  type Classification, type Config, type Effort, type Level,
  EFFORTS, LEVELS, classify, merge, readPrefix,
} from './classify'

type Decision = {
  at: string
  level: Level | 'lock'
  model: string
  effort: Effort
  reason: string
  source: 'auto' | 'prefix' | 'lock'
  score?: number
  escalated?: boolean
}
type Lock = { model: string; effort: Effort }

const STORE_ENABLED = 'enabled'
const STORE_LOCK = 'lock'


// État de la session (repart à zéro à un rechargement du mod, sans conséquence).
const S = {
  current: undefined as Decision | undefined, // ce qui s'applique au tour en cours
  lastShown: '', // dernier « modèle · effort » affiché, pour ne toaster qu'aux changements
  previousText: undefined as string | undefined,
  previousLevel: undefined as Level | undefined,
  previousTurnFailed: false,
  toolErrors: 0,
  logQueue: Promise.resolve() as Promise<void>,
}

// ---------- fichiers ----------

async function dataDir($: EngineInterface) {
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/model-router` : `${$.plugin.root}/data`
}
async function configPath($: EngineInterface) {
  return `${await dataDir($)}/config.json`
}
async function logPath($: EngineInterface) {
  return `${await dataDir($)}/decisions.jsonl`
}

/** config.json du mod (valeurs par défaut) + ~/.claude/model-router/config.json (vos réglages). */
async function loadConfig($: EngineInterface): Promise<Config> {
  const defaults = JSON.parse(await $.fs.read(`${$.plugin.root}/config.json`)) as Config
  const path = await configPath($)
  if (!(await $.fs.exists(path))) return defaults
  return merge(defaults, JSON.parse(await $.fs.read(path)))
}

/** Ajoute une ligne au journal, en file d'attente, sans retarder l'envoi. */
function log($: EngineInterface, d: Decision, maxLines: number) {
  S.logQueue = S.logQueue
    .then(async () => {
      const path = await logPath($)
      const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
      const lines = old.split('\n').filter(Boolean)
      lines.push(JSON.stringify(d))
      await $.fs.write(path, lines.slice(-maxLines).join('\n') + '\n')
    })
    .catch(() => undefined) // un journal raté ne doit jamais gêner le routage
}

// ---------- affichage ----------

async function showStatus($: EngineInterface) {
  const enabled = (await $.store.get(STORE_ENABLED)) !== false
  const lock = (await $.store.get(STORE_LOCK)) as Lock | undefined
  if (!enabled) return $.ui.status('router: off')
  if (lock) return $.ui.status(`router 🔒 ${lock.model} · ${lock.effort}`)
  if (!S.current) return $.ui.status('router: en attente')
  $.ui.status(`router: ${S.current.model} · ${S.current.effort} (${S.current.level})`)
}

function announce($: EngineInterface, d: Decision) {
  const shown = `${d.model} · ${d.effort}`
  if (shown !== S.lastShown) $.ui.toast(`→ ${shown} : ${d.reason}`)
  S.lastShown = shown
}

/** Résume le journal : répartition par niveau et par modèle · effort. */
async function stats($: EngineInterface, days?: number): Promise<string> {
  const path = await logPath($)
  if (!(await $.fs.exists(path))) return 'Journal vide pour l’instant.'
  const since = days ? (await $.clock.now()) - days * 86_400_000 : 0
  const rows = (await $.fs.read(path))
    .split('\n')
    .filter(Boolean)
    .flatMap(l => { try { return [JSON.parse(l) as Decision] } catch { return [] } })
    .filter(d => Date.parse(d.at) >= since)
  if (rows.length === 0) return 'Aucune décision sur la période.'
  const count = (key: (d: Decision) => string) => {
    const m = new Map<string, number>()
    for (const d of rows) m.set(key(d), (m.get(key(d)) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `  ${k.padEnd(18)} ${String(n).padStart(4)}  ${Math.round((100 * n) / rows.length)} %`)
      .join('\n')
  }
  const escal = rows.filter(d => d.escalated).length
  return [
    `${rows.length} décisions${days ? ` sur ${days} jour(s)` : ''}, ${escal} escalade(s)`,
    'Par niveau :', count(d => d.level),
    'Par modèle · effort :', count(d => `${d.model} · ${d.effort}`),
    'Par source :', count(d => d.source),
  ].join('\n')
}

export const register: Register = on => {
  // ---------- démarrage ----------

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Routage auto du modèle : on | off | status | stats | lock <modèle> <effort> | unlock | config',
      argumentHint: '[on|off|status|stats|lock|unlock|config]',
      immediate: true,
    })
    // Première fois : on dépose une copie de la config là où vous pourrez l'éditer.
    try {
      const path = await configPath($)
      if (!(await $.fs.exists(path))) await $.fs.write(path, await $.fs.read(`${$.plugin.root}/config.json`))
    } catch {
      /* sans conséquence : les valeurs par défaut du mod s'appliquent */
    }
    await showStatus($)
    return next(e)
  })

  // ---------- 1. classification à l'envoi ----------

  // Origines routées : ce que vous tapez (terminal, app, SDK) et les prompts de plugins.
  const ROUTED = new Set(['composer', 'bridge', 'sdk', 'plugin'])

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || (e.origin !== undefined && !ROUTED.has(e.origin.kind))) return next(e)

    let text = e.text
    try {
      const cfg = await loadConfig($)
      const enabled = (await $.store.get(STORE_ENABLED)) ?? cfg.enabled
      const lock = (await $.store.get(STORE_LOCK)) as Lock | undefined
      const at = new Date(await $.clock.now()).toISOString()
      const failed = S.previousTurnFailed || S.toolErrors >= cfg.escalation.failedToolCalls
      S.previousTurnFailed = false
      S.toolErrors = 0

      // Le préfixe est retiré du message même quand le routeur est coupé.
      const forced = readPrefix(text, cfg)
      if (forced) text = forced.text

      if (enabled === false) {
        S.current = undefined
      } else if (lock) {
        S.current = { at, level: 'lock', ...lock, reason: 'réglage verrouillé par /router lock', source: 'lock' }
      } else if (forced) {
        const { model, effort } = cfg.levels[forced.level]
        S.current = { at, level: forced.level, model, effort, reason: `forcé par le préfixe ${forced.prefix}`, source: 'prefix' }
        S.previousLevel = forced.level
      } else {
        const c: Classification = classify(
          {
            text,
            attachments: e.attachments?.length ?? 0,
            sessionTurns: await $.session.turns(),
            previousText: S.previousText,
            previousLevel: S.previousLevel,
            previousFailed: failed,
          },
          cfg,
        )
        const { model, effort } = cfg.levels[c.level]
        S.current = { at, level: c.level, model, effort, reason: c.reason, source: 'auto', score: c.score, escalated: c.escalated }
        S.previousLevel = c.level
      }
      S.previousText = text

      if (S.current) {
        announce($, S.current)
        log($, S.current, cfg.logMaxLines)
      }
      await showStatus($)
    } catch (err) {
      // Repli : pas de décision, votre réglage actuel s'applique.
      S.current = undefined
      $.ui.status('router: erreur, réglage actuel conservé')
      $.ui.log(`model-router: ${String(err)}`)
    }
    return next(text === e.text ? e : { ...e, text })
  }).catch(($, e, next) => next(e))

  // ---------- 2. application à chaque requête du fil principal ----------

  on('turn.step', async function* ($, e, next) {
    // Les sous-agents gardent leur propre modèle ; sans décision, rien ne change.
    if (e.agentId !== undefined || S.current === undefined) return yield* next(e)
    return yield* next({ ...e, model: S.current.model, effort: S.current.effort })
  })

  // ---------- 3. détection des échecs pour l'escalade ----------

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === true) S.toolErrors += 1
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    // Interrompu (Échap) ou en erreur : le prochain message monte d'un cran.
    if (e.agentId === undefined && (e.reason === 'error' || e.reason === 'aborted')) S.previousTurnFailed = true
    return next(e)
  })

  // ---------- 4. /router ----------

  on('command.run', { command: 'router' }, async ($, e) => {
    const [sub = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    switch (sub.toLowerCase()) {
      case 'on':
        await $.store.set(STORE_ENABLED, true)
        await showStatus($)
        return { text: 'Routage activé.' }
      case 'off':
        await $.store.set(STORE_ENABLED, false)
        S.current = undefined
        await showStatus($)
        return { text: 'Routage coupé : votre réglage /model et effort s’applique.' }
      case 'lock': {
        const cfg = await loadConfig($)
        // « /router lock complex » prend le modèle et l'effort d'un niveau.
        const asLevel = LEVELS.find(l => l === rest[0])
        const lock: Lock | undefined = asLevel
          ? cfg.levels[asLevel]
          : rest[0] && EFFORTS.includes(rest[1] as Effort)
            ? { model: rest[0], effort: rest[1] as Effort }
            : undefined
        if (!lock) return { text: `Usage : /router lock <modèle> <${EFFORTS.join('|')}>  ou  /router lock <${LEVELS.join('|')}>` }
        await $.store.set(STORE_LOCK, lock)
        await showStatus($)
        return { text: `Verrouillé sur ${lock.model} · ${lock.effort} jusqu’à /router unlock.` }
      }
      case 'unlock':
        await $.store.delete(STORE_LOCK)
        await showStatus($)
        return { text: 'Verrou levé, retour au routage automatique.' }
      case 'stats':
        return { text: await stats($, Number(rest[0]) || undefined) }
      case 'config':
        return { text: `Config : ${await configPath($)}\nJournal : ${await logPath($)}\n(relue à chaque message, aucun redémarrage nécessaire)` }
      case 'status':
      default: {
        const enabled = (await $.store.get(STORE_ENABLED)) !== false
        const lock = (await $.store.get(STORE_LOCK)) as Lock | undefined
        const head = !enabled ? 'Routage : off' : lock ? `Routage : verrouillé (${lock.model} · ${lock.effort})` : 'Routage : on'
        if (!S.current) return { text: `${head}\nAucun choix encore pour cette session.` }
        const c = S.current
        return {
          text: `${head}\nDernier choix : ${c.level} → ${c.model} · ${c.effort}\nRaison : ${c.reason}` +
            (c.score !== undefined ? `\nScore : ${c.score}${c.escalated ? ' (escaladé)' : ''}` : ''),
        }
      }
    }
  })
}
