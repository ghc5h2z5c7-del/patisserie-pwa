// @ts-nocheck : le kit de test type son `$` autrement que le moteur ; ce fichier tourne sous `claude plugin test`.
// Tests de bout en bout dans le moteur des mods : message envoyé → décision → requête modèle réécrite.
// Le moteur de test n'a pas de disque : la config du mod (copie de config.json) lui est servie par un hook fs.read.
import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

const CONFIG: string = "{\"enabled\": true, \"levels\": {\"simple\": {\"model\": \"haiku\", \"effort\": \"low\"}, \"standard\": {\"model\": \"sonnet\", \"effort\": \"medium\"}, \"complex\": {\"model\": \"opus\", \"effort\": \"high\"}, \"critical\": {\"model\": \"opus\", \"effort\": \"max\"}}, \"thresholds\": {\"standard\": 2, \"complex\": 5, \"critical\": 12}, \"length\": {\"short\": 60, \"medium\": 300, \"mediumWeight\": 1, \"long\": 1200, \"longWeight\": 2, \"veryLong\": 4000, \"veryLongWeight\": 3}, \"keywords\": {\"simple\": {\"weight\": -2, \"words\": [\"c'est quoi\", \"qu'est-ce que\", \"qu'est ce que\", \"combien\", \"definition\", \"reformule\", \"traduis\", \"typo\", \"faute\", \"orthographe\", \"renomme\", \"rappelle-moi\", \"quelle commande\", \"git status\", \"git log\", \"git diff\", \"git pull\", \"git push\", \"git add\", \"git commit\", \"git checkout\", \"what is\", \"rename\", \"rephrase\"]}, \"standard\": {\"weight\": 1.5, \"words\": [\"ecri\", \"fonction\", \"function\", \"implement\", \"ajout\", \"composant\", \"component\", \"explique\", \"explain\", \"test\", \"corrige\", \"modifie\", \"endpoint\", \"classe\", \"methode\", \"script\", \"redige\", \"write\"]}, \"complex\": {\"weight\": 3, \"words\": [\"refactor\", \"architectur\", \"migr\", \"audit\", \"securite\", \"security\", \"vulnerab\", \"debug\", \"debogu\", \"bug\", \"race condition\", \"fuite memoire\", \"memory leak\", \"performance\", \"optimis\", \"concurren\", \"deadlock\", \"injection\", \"plusieurs fichiers\", \"multi-fichiers\", \"intermittent\", \"plan\"]}, \"critical\": {\"weight\": 6, \"words\": [\"planifier\", \"plan detaille\", \"feuille de route\", \"roadmap\", \"strategie\", \"refonte complete\", \"from scratch\", \"tout reecrire\", \"fort enjeu\", \"en production\", \"irreversible\", \"ambigu\", \"flou\", \"arbitrage\", \"trade-off\", \"risques\"]}}, \"signals\": {\"perFile\": 0.75, \"manyFiles\": 3, \"manyFilesBonus\": 2, \"stackTrace\": 2.5, \"codeBlock\": 1, \"attachment\": 1, \"why\": 1, \"listItems\": 4, \"listBonus\": 1, \"longSessionTurns\": 40, \"longSessionBonus\": 1}, \"escalation\": {\"similarity\": 0.6, \"failedToolCalls\": 2, \"correctionPatterns\": [\"^non\\\\b\", \"^nope\\\\b\", \"^no\\\\b\", \"^pas (ca|comme)\", \"^toujours\", \"^encore\\\\b\", \"ne (marche|fonctionne) (toujours |encore )?pas\", \"^c'est (faux|pas ca)\", \"tu t'es trompe\", \"^recommence\", \"^reessaie\", \"^retry\", \"^still\\\\b\", \"^wrong\\\\b\", \"^that's not\", \"doesn't work\"]}, \"prefixes\": {\"!fast\": \"simple\", \"!simple\": \"simple\", \"!std\": \"standard\", \"!standard\": \"standard\", \"!deep\": \"complex\", \"!complex\": \"complex\", \"!max\": \"critical\", \"!critical\": \"critical\"}, \"logMaxLines\": 5000}"

const EXAMPLES: [string, string][] = [
  ['simple', "C'est quoi la différence entre git fetch et git pull ?"],
  ['simple', "Fais un git status puis commit avec le message 'fix typo'"],
  ['standard', 'Écris une fonction formatPrice(cents) dans src/utils/price.js qui renvoie le prix formaté en euros.'],
  ['standard', 'Explique-moi ce que fait le hook useCart dans src/hooks/useCart.ts, et pourquoi il se re-rend autant.'],
  ['complex', 'Refactor la gestion du panier : déplace la logique de src/cart.js, src/checkout.js et src/api/orders.js dans un store unique, puis migre les composants qui en dépendent.'],
  ['critical', "Je dois planifier la refonte complète de l'application (offline-first, paiement en ligne, multi-boutiques). Les besoins sont encore flous et l'app est en production : propose un plan détaillé avec les étapes, les risques et les arbitrages avant qu'on commence."],
]

type Sent = { model: string; effort?: unknown }
export const toasts: string[] = []
export const status: string[] = []

/** Moteur simulé : un disque en mémoire avec la config du mod, et un modèle qui note ce qu'on lui demande. */
const engine = (on: On, sent: Sent[]) => {
  mock.store(on)
  const files = new Map<string, string>()
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? CONFIG }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/home/test' }))
  on('clock.now', () => ({ value: Date.parse('2026-11-12T10:00:00Z') }))
  on('ui.status', (_, e) => { status.push(String(e.text)); return { value: undefined } })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', (_, e) => { toasts.push('LOG ' + e.text); return { value: undefined } })
  on('session.turns', () => ({ value: 3 }))
  on('command.register', () => ({ value: { command: 'router' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.step', async function* (_, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return files
}

const send = async ($: EngineInterface, text: string) => {
  await $.prompt.submit({ text })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
  for await (const _ of stream) {
    /* on vide le flux */
  }
}

test('les 6 messages d’exemple', async ($, on) => {
  const sent: Sent[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const rows: string[] = []
  for (const [want, text] of EXAMPLES) {
    await send($, text)
    const status = await $.command.run({ command: 'router', args: 'status' })
    const got = sent.at(-1)
    rows.push(`[attendu ${want}] → ${got?.model} · ${String(got?.effort)}\n    « ${text} »\n    ${status.text?.split('\n').slice(1).join(' | ')}`)
    expect(status.text).toContain(`Dernier choix : ${want}`)
  }
  console.log('\n' + rows.join('\n\n'))
})

test('escalade sur correction, préfixe, lock, off, stats', async ($, on) => {
  const sent: Sent[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await send($, 'Écris une fonction slugify(title) dans src/utils/slug.js.')
  expect(sent.at(-1)).toEqual({ model: 'sonnet', effort: 'medium' })
  await send($, 'Non, ça ne marche toujours pas avec les accents.')
  expect(sent.at(-1)).toEqual({ model: 'opus', effort: 'high' }) // un cran au-dessus
  await send($, "Merci. C'est quoi git stash ?")
  expect(sent.at(-1)).toEqual({ model: 'haiku', effort: 'low' }) // redescend

  await send($, '!max liste les fichiers')
  expect(sent.at(-1)).toEqual({ model: 'opus', effort: 'max' })

  await $.command.run({ command: 'router', args: 'lock sonnet high' })
  await send($, "Refactor complet de l'architecture")
  expect(sent.at(-1)).toEqual({ model: 'sonnet', effort: 'high' })
  await $.command.run({ command: 'router', args: 'unlock' })

  await $.command.run({ command: 'router', args: 'off' })
  await send($, "Refactor complet de l'architecture")
  expect(sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' }) // réglage de la session intact
  await $.command.run({ command: 'router', args: 'on' })

  const stats = await $.command.run({ command: 'router', args: 'stats' })
  console.log('\n/router stats →\n' + stats.text)
  expect(stats.text).toContain('décisions')
})
