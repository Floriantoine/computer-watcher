import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MigrationReport } from '../../../core/nameMigration';
import { MigrationStatus } from './AppSetup';

const noop = () => {};
const r = (o: Partial<MigrationReport>): MigrationReport => ({ status: 'done', done: [], errors: {}, leftInPlace: [], skipped: {}, ...o });
const html = (report: MigrationReport | undefined) => renderToStaticMarkup(createElement(MigrationStatus, { report, busy: false, onRetry: noop }));

describe('Réglages › À propos : migration depuis proc-watch', () => {
  it('rien à migrer (ou version qui ne la connaît pas) : rien d’affiché', () => {
    expect(html(r({ status: 'nothing' }))).toBe('');
    expect(html(undefined)).toBe('');
  });
  it('faite : une ligne, pas de bouton', () => {
    const h = html(r({ status: 'done' }));
    expect(h).toContain('Migration depuis proc-watch : faite.');
    expect(h).not.toContain('data-testid="migration-retry"');
  });
  it('partielle : le détail et « Réessayer »', () => {
    const h = html(r({ status: 'partial', errors: { 'move-dirs': '/c/proc-watch : lien symbolique' }, leftInPlace: ['/d/proc-watch'] }));
    expect(h).toContain('Migration depuis proc-watch : partielle.');
    expect(h).toContain('Déplacement des dossiers : /c/proc-watch : lien symbolique');
    expect(h).toContain('Laissé en place : /d/proc-watch');
    expect(h).toContain('data-testid="migration-retry"');
  });
  it('différée : « Réessayer »', () => {
    expect(html(r({ status: 'deferred' }))).toContain('data-testid="migration-retry"');
  });
});
