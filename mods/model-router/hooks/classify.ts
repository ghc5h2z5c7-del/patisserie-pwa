// Classification locale d'un message : règles et heuristiques, aucun appel de modèle.
// Tout est pur (pas de `$`) pour être testé et ajusté facilement.
// Les poids, mots-clés et seuils viennent de config.json : changez-les là, pas ici.

export const LEVELS = ['simple', 'standard', 'complex', 'critical'] as const
export type Level = (typeof LEVELS)[number]
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type Config = {
  enabled: boolean
  levels: Record<Level, { model: string; effort: Effort }>
  thresholds: { standard: number; complex: number; critical: number }
  length: {
    short: number
    medium: number; mediumWeight: number
    long: number; longWeight: number
    veryLong: number; veryLongWeight: number
  }
  keywords: Record<Level, { weight: number; words: string[] }>
  signals: {
    perFile: number; manyFiles: number; manyFilesBonus: number
    stackTrace: number; codeBlock: number; attachment: number; why: number
    listItems: number; listBonus: number
    longSessionTurns: number; longSessionBonus: number
  }
  escalation: { similarity: number; failedToolCalls: number; correctionPatterns: string[] }
  prefixes: Record<string, Level>
  logMaxLines: number
}

/** Ce que le routeur sait du message et de la session. */
export type ClassifyInput = {
  text: string
  attachments: number
  sessionTurns: number
  previousText?: string
  previousLevel?: Level
  previousFailed: boolean
}

export type Signal = { label: string; weight: number }

export type Classification = {
  level: Level
  score: number
  signals: Signal[]
  escalated: boolean
  reason: string
}

/** Minuscules, sans accents : « Sécurité » et « securite » se valent. */
export const normalize = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Comment chaque groupe de mots-clés est nommé dans la raison affichée. */
const GROUP_LABEL: Record<Level, string> = {
  simple: 'demande simple',
  standard: 'tâche de code',
  complex: 'tâche complexe',
  critical: 'fort enjeu',
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Un mot-clé correspond au début d'un mot : « migr » attrape migrer, migration… */
const matches = (text: string, word: string) =>
  new RegExp(`(^|[^a-z0-9])${escapeRe(normalize(word))}`).test(text)

const PATH_RE =
  /(?:[\w.-]+\/)+[\w.-]+\.\w+|\b[\w-]+\.(?:js|mjs|ts|tsx|jsx|py|go|rs|java|json|ya?ml|md|css|scss|html|sql|sh|rb|php|c|cpp|h|kt|swift|vue|svelte)\b/g

const STACK_RES = [
  /^\s+at .+[:(]\d+/m, // JS / Java
  /Traceback \(most recent call last\)/, // Python
  /\b\w*(Error|Exception):\s/, // TypeError: …
  /^panic:/m, // Go
  /^\s*File ".+", line \d+/m,
]

/** Similarité de Jaccard entre deux messages (mots de 3 lettres et plus). */
export const similarity = (a: string, b: string): number => {
  const words = (s: string) => new Set(normalize(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3))
  const A = words(a)
  const B = words(b)
  if (A.size === 0 || B.size === 0) return 0
  let common = 0
  for (const w of A) if (B.has(w)) common += 1
  return common / (A.size + B.size - common)
}

export const isCorrection = (text: string, cfg: Config): boolean => {
  const t = normalize(text.trim())
  return cfg.escalation.correctionPatterns.some(p => new RegExp(p).test(t))
}

const levelFromScore = (score: number, cfg: Config): Level =>
  score >= cfg.thresholds.critical ? 'critical'
    : score >= cfg.thresholds.complex ? 'complex'
      : score >= cfg.thresholds.standard ? 'standard'
        : 'simple'

const bump = (level: Level): Level => LEVELS[Math.min(LEVELS.indexOf(level) + 1, LEVELS.length - 1)] ?? 'critical'
const maxLevel = (a: Level, b: Level): Level => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b)

export const classify = (input: ClassifyInput, cfg: Config): Classification => {
  const raw = input.text
  const text = normalize(raw)
  const signals: Signal[] = []
  const add = (label: string, weight: number) => weight !== 0 && signals.push({ label, weight })

  // 1. Longueur et structure.
  const L = cfg.length
  if (raw.length >= L.veryLong) add('message très long', L.veryLongWeight)
  else if (raw.length >= L.long) add('message long', L.longWeight)
  else if (raw.length >= L.medium) add('message de taille moyenne', L.mediumWeight)
  else if (raw.length < L.short) add('message court', -1)

  const S = cfg.signals
  const listItems = raw.split('\n').filter(l => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length
  if (listItems >= S.listItems) add(`${listItems} points structurés`, S.listBonus)

  // 2. Mots-clés : le premier mot d'un groupe compte plein pot, les suivants à moitié (2 max).
  for (const level of LEVELS) {
    const group = cfg.keywords[level]
    const found = group.words.filter(w => matches(text, w))
    if (found.length === 0) continue
    const weight = group.weight * (1 + 0.5 * Math.min(found.length - 1, 2))
    add(`${GROUP_LABEL[level]} « ${found.slice(0, 2).join(", ")} »`, weight)
  }
  if (/\bpourquoi\b|\bwhy\b/.test(text)) add('question « pourquoi »', S.why)

  // 3. Fichiers et chemins cités.
  const files = new Set(raw.match(PATH_RE) ?? [])
  if (files.size > 0) add(`${files.size} fichier${files.size > 1 ? 's' : ''} cité${files.size > 1 ? 's' : ''}`, files.size * S.perFile)
  if (files.size >= S.manyFiles) add('plusieurs fichiers touchés', S.manyFilesBonus)

  // 4. Pièces jointes, logs, stack traces, blocs de code.
  if (STACK_RES.some(re => re.test(raw))) add('stack trace ou log détecté', S.stackTrace)
  if (/```/.test(raw)) add('bloc de code joint', S.codeBlock)
  if (input.attachments > 0) add(`${input.attachments} pièce(s) jointe(s)`, Math.min(input.attachments, 2) * S.attachment)

  // 5. Contexte de la session.
  if (input.sessionTurns >= S.longSessionTurns) add('conversation déjà longue', S.longSessionBonus)

  const score = signals.reduce((sum, s) => sum + s.weight, 0)
  let level = levelFromScore(score, cfg)

  // 6. Escalade : correction, répétition ou échec au tour précédent → un cran au-dessus.
  let escalated = false
  if (input.previousLevel !== undefined) {
    const repeated =
      input.previousText !== undefined && similarity(raw, input.previousText) >= cfg.escalation.similarity
    const why = input.previousFailed ? 'échec au tour précédent'
      : isCorrection(raw, cfg) ? 'correction de ma part'
        : repeated ? 'demande répétée'
          : undefined
    if (why !== undefined) {
      const target = maxLevel(level, bump(input.previousLevel))
      escalated = target !== level
      level = target
      signals.push({ label: `${why}, escalade d'un cran`, weight: 100 })
    }
  }

  return { level, score: Math.round(score * 100) / 100, signals, escalated, reason: reasonOf(level, signals) }
}

/**
 * Raison courte (5 à 8 mots environ) : les deux signaux qui pèsent le plus
 * dans le sens du niveau choisi.
 */
const reasonOf = (level: Level, signals: Signal[]): string => {
  const wantsLow = level === 'simple'
  const pick = signals
    .filter(s => (wantsLow ? s.weight < 0 : s.weight > 0))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 2)
    .map(s => s.label)
  if (pick.length === 0) return wantsLow ? 'demande courte, sans signal de complexité' : 'plusieurs signaux de complexité modérés'
  return pick.join(', ')
}

/** Lit un préfixe de forçage (« !max … »). Renvoie le niveau et le texte sans préfixe. */
export const readPrefix = (text: string, cfg: Config): { level: Level; text: string; prefix: string } | undefined => {
  const m = /^\s*(![\w-]+)(\s+|$)/.exec(text)
  const prefix = m?.[1]
  if (!m || prefix === undefined) return undefined
  const level = cfg.prefixes[prefix.toLowerCase()]
  if (level === undefined) return undefined
  return { level, prefix, text: text.slice(m[0].length) }
}

/** Fusionne la config de l'utilisateur sur les valeurs par défaut (objets fusionnés, listes remplacées). */
export const merge = <T>(base: T, over: unknown): T => {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = merge(out[k], v)
  return out as T
}
