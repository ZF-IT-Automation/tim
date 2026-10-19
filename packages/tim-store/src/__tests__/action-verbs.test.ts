import { describe, it, expect } from 'vitest';
import { matchActionVerbs } from '../action-verbs.js';

const terms = (text: string) => matchActionVerbs(text).flatMap(v => v.terms);

describe('matchActionVerbs', () => {
  it.each([
    ['Pushe den Branch bitte', 'push'],
    ['Deploye das auf Strato', 'deploy'],
    ['Installiere hmem-sync neu', 'install'],
    ['Lösche die alten Clones', 'delete'],
    ['Committe das', 'commit'],
    ['Starte den Server neu', 'restart'],
    ['Server neu starten', 'restart'],
    ['Migriere die Datenbank', 'migrate'],
    ['Lade das PDF aufs Tablet hoch', 'upload'],
    ['Führe die Tests aus', 'run'],
    ['Veröffentliche die neue Version', 'publish'],
    ['push it', 'push'],
    ['upload PDF via rmapi', 'upload'],
  ])('%s → %s', (prompt, verb) => {
    expect(terms(prompt)).toContain(verb);
  });

  it.each([
    'Wie funktioniert das Deployment?',
    'Der Start war holprig',
    'Ich habe gestern gepusht',
    'Die Installation ist kaputt',
    'Erklär das bitte ausführlich',
    'Was hältst du von der Migration?',
    'Der Neustart hat geholfen',
  ])('no action in "%s"', prompt => {
    expect(matchActionVerbs(prompt)).toEqual([]);
  });

  it('returns the matched words with the terms', () => {
    expect(matchActionVerbs('Lösche das')).toEqual([{ words: ['lösche'], terms: ['delete', 'löschen'] }]);
  });
});
