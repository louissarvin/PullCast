#!/usr/bin/env node
/**
 * `pullcast` CLI entry point.
 *
 * Mirrors the shape of the official `npx renaiss@0.0.2` CLI:
 *  - Commander with per-subcommand help
 *  - ASCII banner on top-level `--help`
 *  - Read-only verbs only
 *  - `--json` flag on every verb; pretty output otherwise
 *
 * PullCast extends the official Renaiss CLI (`npx renaiss`) with a collector
 * layer: recent-pull lookup by wallet, cross-source price blend, cert
 * valuation with formatting, market indices, and top movers.
 *
 * Security posture:
 *  - No auth, no writes. Every upstream is public/read-only.
 *  - Inputs validated at the boundary (see `commands.ts` regexes).
 *  - Errors print a generic message + code; NEVER a stack trace.
 *  - No colors when NO_COLOR is set or stdout is not a TTY.
 */

import { Command } from 'commander';

import {
  runPull,
  runValuate,
  runMarket,
  runFeatured,
  runPrice,
  runMarketplace,
  runCard,
  runPacks,
  runPackInfo,
  runTrades,
  runReport,
  runSearch,
  runSet,
} from './commands.ts';
import {
  formatGraded,
  formatMarket,
  formatFeatured,
  formatPulls,
  formatPrice,
  formatMarketplace,
  formatCard,
  formatPacks,
  formatPackInfo,
  formatTrades,
  formatSearch,
  formatSet,
} from './format.ts';
import { BETA_DISCLOSURE_LINE } from './envelope.ts';

const VERSION = '0.0.1';

const BANNER_LINES = [
  '██████╗ ██╗   ██╗██╗     ██╗      ██████╗ █████╗ ███████╗████████╗',
  '██╔══██╗██║   ██║██║     ██║     ██╔════╝██╔══██╗██╔════╝╚══██╔══╝',
  '██████╔╝██║   ██║██║     ██║     ██║     ███████║███████╗   ██║   ',
  '██╔═══╝ ██║   ██║██║     ██║     ██║     ██╔══██║╚════██║   ██║   ',
  '██║     ╚██████╔╝███████╗███████╗╚██████╗██║  ██║███████║   ██║   ',
  '╚═╝      ╚═════╝ ╚══════╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ',
];

const RAINBOW = [
  '\x1b[31m',
  '\x1b[91m',
  '\x1b[33m',
  '\x1b[32m',
  '\x1b[36m',
  '\x1b[34m',
];

function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

function banner(): string {
  const colored = supportsColor();
  const art = BANNER_LINES.map((line, i) => {
    if (!colored) return `  ${line}`;
    return `  ${RAINBOW[i % RAINBOW.length]}${line}\x1b[0m`;
  }).join('\n');
  const dim = colored ? '\x1b[2m' : '';
  const reset = colored ? '\x1b[0m' : '';
  // Box matches `npx renaiss@0.0.3-beta.2 --help` shape: 75 dashes wide,
  // two-space left margin, content padded to 75 chars. New copy (2026-07-05)
  // reflects the renaiss 0.0.3+ verb tree: marketplace / card / gacha list /
  // gacha info. Write verbs (`gacha pull`, `gacha buyback`) are intentionally
  // absent — PullCast is read-only.
  const box =
    dim +
    '  ╭───────────────────────────────────────────────────────────────────────────╮\n' +
    '  │  Read-only PullCast layer over the Renaiss ecosystem. Extends renaiss     │\n' +
    '  │  0.0.3+ verb tree: marketplace | card | gacha list | gacha info.          │\n' +
    '  ╰───────────────────────────────────────────────────────────────────────────╯' +
    reset;
  return `\n${art}\n\n${box}\n`;
}

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

function emitJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function emitPretty(text: string): void {
  process.stdout.write(text + '\n');
}

/**
 * Print a generic error line to stderr with a code + safe message. We NEVER
 * echo stack traces or full upstream payloads to end users.
 */
function emitError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pullcast: error: ${msg}\n`);
  process.stderr.write(`\n${BETA_DISCLOSURE_LINE}\n`);
}

function parseIntOpt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected an integer, got "${value}".`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Program factory (exported for tests)
// ---------------------------------------------------------------------------

export interface ProgramDeps {
  /** Injected fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Emit adapters (tests can capture). */
  emit?: {
    json: (payload: unknown) => void;
    pretty: (text: string) => void;
    error: (err: unknown) => void;
  };
  /** Called instead of `process.exit`. Tests set this to throw. */
  exit?: (code: number) => void;
}

export function createProgram(deps: ProgramDeps = {}): Command {
  const emit = deps.emit ?? {
    json: emitJson,
    pretty: emitPretty,
    error: emitError,
  };
  const doExit = deps.exit ?? ((code: number) => process.exit(code));

  const withCtx = <T>(fn: () => Promise<T>) => async (): Promise<T> => {
    return fn();
  };

  const program = new Command();
  program
    .name('pullcast')
    .description(
      'PullCast — community CLI extending `npx renaiss` with a collector layer.'
    )
    .version(VERSION, '-v, --version', 'Print the CLI version')
    .addHelpText('beforeAll', banner())
    .configureOutput({
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
    })
    .exitOverride((err) => {
      // Commander errors: unknown option, missing arg, help displayed.
      // For `--help` / `--version` we want a clean 0 exit.
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
        return doExit(0);
      }
      doExit(err.exitCode ?? 1);
    });

  // -------------------------------------------------------------------------
  // pull <address>
  // -------------------------------------------------------------------------
  program
    .command('pull')
    .description('Show recent Renaiss pulls for a wallet (via PullCast indexer)')
    .argument('<address>', '0x-prefixed EVM wallet address (BSC)')
    .option('--limit <n>', 'Max pulls to return (1-100)', parseIntOpt, 20)
    .option('--json', 'Output raw JSON envelope')
    .action(async (address: string, opts: { limit: number; json?: boolean }) => {
      try {
        const env = await runPull(
          address,
          { limit: opts.limit },
          { config: (await import('./config.ts')).loadConfig(), fetchImpl: deps.fetchImpl }
        );
        if (opts.json) {
          emit.json(env);
        } else {
          emit.pretty(formatPulls(env.data.address, env.data.pulls));
        }
      } catch (err) {
        emit.error(err);
        doExit(1);
      }
    });

  // -------------------------------------------------------------------------
  // price <tokenId-or-cert>
  // -------------------------------------------------------------------------
  program
    .command('price')
    .description(
      'Cross-source price blend for a Renaiss tokenId or graded cert number'
    )
    .argument(
      '<tokenId-or-cert>',
      'A Renaiss tokenId (uint256 string) or a graded cert (e.g. PSA73628064)'
    )
    .option('--json', 'Output raw JSON envelope')
    .action(async (input: string, opts: { json?: boolean }) => {
      try {
        const env = await runPrice(input, {
          config: (await import('./config.ts')).loadConfig(),
          fetchImpl: deps.fetchImpl,
        });
        if (opts.json) {
          emit.json(env);
        } else {
          emit.pretty(formatPrice(env.data));
        }
      } catch (err) {
        emit.error(err);
        doExit(1);
      }
    });

  // -------------------------------------------------------------------------
  // valuate <cert>
  // -------------------------------------------------------------------------
  program
    .command('valuate')
    .description('Graded cert valuation via Renaiss OS Index /v1/graded/{cert}')
    .argument('<cert>', 'Graded cert number (e.g. PSA73628064)')
    .option('--json', 'Output raw JSON envelope')
    .action(async (cert: string, opts: { json?: boolean }) => {
      try {
        const env = await runValuate(cert, {
          config: (await import('./config.ts')).loadConfig(),
          fetchImpl: deps.fetchImpl,
        });
        if (opts.json) {
          emit.json(env);
        } else {
          emit.pretty(formatGraded(env.data));
        }
      } catch (err) {
        emit.error(err);
        doExit(1);
      }
    });

  // -------------------------------------------------------------------------
  // market [--game]
  // -------------------------------------------------------------------------
  program
    .command('market')
    .description(
      'Renaiss OS Index basket-level tiles across pokemon / one-piece / sports'
    )
    .option('--game <slug>', 'Filter to one game: pokemon | one-piece | sports')
    .option('--json', 'Output raw JSON envelope')
    .action(async (opts: { game?: string; json?: boolean }) => {
      try {
        const env = await runMarket(
          { game: opts.game as 'pokemon' | 'one-piece' | 'sports' | undefined },
          {
            config: (await import('./config.ts')).loadConfig(),
            fetchImpl: deps.fetchImpl,
          }
        );
        if (opts.json) {
          emit.json(env);
        } else {
          emit.pretty(formatMarket(env.data.indices, env.data.game ?? undefined));
        }
      } catch (err) {
        emit.error(err);
        doExit(1);
      }
    });

  // -------------------------------------------------------------------------
  // featured [--limit]
  // -------------------------------------------------------------------------
  program
    .command('featured')
    .description('Renaiss OS Index featured / top-mover cards')
    .option('--limit <n>', 'Number of cards (1-24)', parseIntOpt, 6)
    .option('--json', 'Output raw JSON envelope')
    .action(async (opts: { limit: number; json?: boolean }) => {
      try {
        const env = await runFeatured(
          { limit: opts.limit },
          {
            config: (await import('./config.ts')).loadConfig(),
            fetchImpl: deps.fetchImpl,
          }
        );
        if (opts.json) {
          emit.json(env);
        } else {
          emit.pretty(formatFeatured(env.data.cards));
        }
      } catch (err) {
        emit.error(err);
        doExit(1);
      }
    });

  // -------------------------------------------------------------------------
  // trades [--limit] — Renaiss OS Index live feed (collector layer)
  // -------------------------------------------------------------------------
  program
    .command('trades')
    .description('Recent graded card trades from Renaiss OS Index /v1/trades/recent')
    .option('--limit <n>', 'Number of trades (1-50)', parseIntOpt, 10)
    .option('--json', 'Output raw JSON envelope')
    .action(async (opts: { limit: number; json?: boolean }) => {
      try {
        const env = await runTrades(
          { limit: opts.limit },
          {
            config: (await import('./config.ts')).loadConfig(),
            fetchImpl: deps.fetchImpl,
          }
        );
        if (opts.json) {
          emit.json(env);
        } else {
          emit.pretty(formatTrades(env.data.trades));
        }
      } catch (err) {
        emit.error(err);
        doExit(1);
      }
    });

  // -------------------------------------------------------------------------
  // search <query> — Renaiss OS Index card search
  // -------------------------------------------------------------------------
  program
    .command('search')
    .description('Search graded cards via Renaiss OS Index /v1/search')
    .argument('<query>', 'Search term (min 2 characters)')
    .option('--limit <n>', 'Number of results (1-50)', parseIntOpt, 10)
    .option('--game <slug>', 'Filter by game: pokemon | one-piece | sports')
    .option('--set <slug>', 'Filter by set slug')
    .option('--json', 'Output raw JSON envelope')
    .action(
      async (
        query: string,
        opts: {
          limit: number;
          game?: string;
          set?: string;
          json?: boolean;
        }
      ) => {
        try {
          const env = await runSearch(
            query,
            { limit: opts.limit, game: opts.game, set: opts.set },
            {
              config: (await import('./config.ts')).loadConfig(),
              fetchImpl: deps.fetchImpl,
            }
          );
          if (opts.json) {
            emit.json(env);
          } else {
            emit.pretty(formatSearch(env.data.query, env.data.results));
          }
        } catch (err) {
          emit.error(err);
          doExit(1);
        }
      }
    );

  // -------------------------------------------------------------------------
  // set <game> <setSlug> — Renaiss OS Index set listing
  // -------------------------------------------------------------------------
  program
    .command('set')
    .description('Renaiss OS Index set listing (GET /v1/sets/{game}/{set})')
    .argument('<game>', 'pokemon | one-piece | sports')
    .argument('<set>', 'Set slug from Index href (e.g. pokemon-japanese-sv2a-pokemon-151)')
    .option('--json', 'Output raw JSON envelope')
    .action(async (game: string, set: string, opts: { json?: boolean }) => {
      try {
        const env = await runSet(game, set, {
          config: (await import('./config.ts')).loadConfig(),
          fetchImpl: deps.fetchImpl,
        });
        if (opts.json) {
          emit.json(env);
        } else {
          emit.pretty(formatSet(env.data));
        }
      } catch (err) {
        emit.error(err);
        doExit(1);
      }
    });

  // -------------------------------------------------------------------------
  // report --reason "..." [--cert] [--token]
  // -------------------------------------------------------------------------
  program
    .command('report')
    .description('Report a Renaiss OS Index data issue (forwards to /v1/report)')
    .requiredOption('--reason <text>', 'Description of the data issue (required)')
    .option('--cert <cert>', 'Graded cert number (PSA...)')
    .option('--token <id>', 'Renaiss tokenId')
    .option('--evidence <url>', 'Optional evidence URL')
    .option('--json', 'Output raw JSON envelope')
    .action(
      async (opts: {
        reason: string;
        cert?: string;
        token?: string;
        evidence?: string;
        json?: boolean;
      }) => {
        try {
          const env = await runReport(
            {
              reason: opts.reason,
              cert: opts.cert,
              tokenId: opts.token,
              evidence: opts.evidence,
            },
            {
              config: (await import('./config.ts')).loadConfig(),
              fetchImpl: deps.fetchImpl,
            }
          );
          if (opts.json) {
            emit.json(env);
          } else {
            emit.pretty(
              env.data.received
                ? `Report received.${env.data.reportId ? ` ID: ${env.data.reportId}` : ''}`
                : 'Report not accepted.'
            );
          }
        } catch (err) {
          emit.error(err);
          doExit(1);
        }
      }
    );

  // -------------------------------------------------------------------------
  // marketplace (mirrors `npx renaiss marketplace`)
  // -------------------------------------------------------------------------
  program
    .command('marketplace')
    .description(
      'Browse the Renaiss marketplace (mirrors `npx renaiss marketplace`)'
    )
    .option('--search <term>', 'Search collectibles (min 3 chars)')
    .option('--category <name>', 'Filter by category (POKEMON, ONE_PIECE)')
    .option('--listed', 'Show only listed collectibles')
    .option('--language <lang>', 'Filter by language')
    .option('--grading <company>', 'Filter by grading company (PSA, BGS, CGC, SGC)')
    .option('--grade <value>', 'Filter by grade')
    .option('--year <range>', 'Filter by year range')
    .option('--price <range>', 'Filter by price range')
    .option('--sort <field>', 'Sort by field', 'listDate')
    .option('--order <dir>', 'Sort order (asc, desc)', 'desc')
    .option('--limit <n>', 'Results per page (1-100)', parseIntOpt, 10)
    .option('--offset <n>', 'Pagination offset', parseIntOpt, 0)
    .option('--json', 'Output raw JSON envelope')
    .action(
      async (opts: {
        search?: string;
        category?: string;
        listed?: boolean;
        language?: string;
        grading?: string;
        grade?: string;
        year?: string;
        price?: string;
        sort?: string;
        order?: string;
        limit: number;
        offset: number;
        json?: boolean;
      }) => {
        try {
          const env = await runMarketplace(
            {
              search: opts.search,
              category: opts.category,
              listed: opts.listed,
              language: opts.language,
              grading: opts.grading,
              grade: opts.grade,
              year: opts.year,
              price: opts.price,
              sort: opts.sort,
              order: opts.order,
              limit: opts.limit,
              offset: opts.offset,
            },
            {
              config: (await import('./config.ts')).loadConfig(),
              fetchImpl: deps.fetchImpl,
            }
          );
          if (opts.json) {
            emit.json(env);
          } else {
            emit.pretty(
              formatMarketplace(env.data.collection, env.data.pagination)
            );
          }
        } catch (err) {
          emit.error(err);
          doExit(1);
        }
      }
    );

  // -------------------------------------------------------------------------
  // card <tokenId> (mirrors `npx renaiss card`)
  // -------------------------------------------------------------------------
  program
    .command('card')
    .description(
      "View a single collectible's detail, price, or activity history (mirrors `npx renaiss card`)"
    )
    .argument('<tokenId>', 'A Renaiss tokenId (uint256 string)')
    .option('--price', 'Show price information', true)
    .option('--activities', 'Show activity history')
    .option('--verbose', 'Show extended price details with --price')
    .option('--json', 'Output raw JSON envelope')
    .action(
      async (
        tokenId: string,
        opts: {
          price?: boolean;
          activities?: boolean;
          verbose?: boolean;
          json?: boolean;
        }
      ) => {
        try {
          const env = await runCard(
            tokenId,
            {
              price: opts.price,
              activities: opts.activities,
              verbose: opts.verbose,
            },
            {
              config: (await import('./config.ts')).loadConfig(),
              fetchImpl: deps.fetchImpl,
            }
          );
          if (opts.json) {
            emit.json(env);
          } else {
            emit.pretty(formatCard(env.data));
          }
        } catch (err) {
          emit.error(err);
          doExit(1);
        }
      }
    );

  // -------------------------------------------------------------------------
  // gacha (mirrors `renaiss gacha` command group as of 0.0.3-beta.2)
  //
  // Upstream ships `gacha list | pull | buyback`. PullCast intentionally
  // mirrors only the READ verbs (`list`, plus a companion `info`) — the write
  // verbs (`pull`, `buyback`) require Safe signatures + real USDT and are
  // OUT OF SCOPE for the read-only community layer. Suggest the official
  // `npx renaiss gacha pull` / `npx renaiss gacha buyback` when users ask.
  // -------------------------------------------------------------------------
  const gachaListHandler = async (
    slug: string | undefined,
    opts: { includeInactive?: boolean; json?: boolean }
  ): Promise<void> => {
    try {
      const env = await runPacks(
        {
          slug: typeof slug === 'string' && slug.length > 0 ? slug : undefined,
          includeInactive: opts.includeInactive === true,
        },
        {
          config: (await import('./config.ts')).loadConfig(),
          fetchImpl: deps.fetchImpl,
        }
      );
      if (opts.json) {
        emit.json(env);
      } else {
        emit.pretty(formatPacks(env.data.packs, env.data.mode));
      }
    } catch (err) {
      emit.error(err);
      doExit(1);
    }
  };

  const gacha = program
    .command('gacha')
    .description(
      'List, view, and inspect gacha packs (read-only mirror of `renaiss gacha`).'
    );

  gacha
    .command('list')
    .description('List and inspect gacha packs (mirrors `renaiss gacha list`).')
    .argument(
      '[slug]',
      'Optional pack slug (e.g. eden-pack); when set, prints pack detail.'
    )
    .option('--include-inactive', 'Include inactive packs in list output')
    .option('--json', 'Output raw JSON')
    .action(gachaListHandler);

  gacha
    .command('info')
    .description(
      'Pack metadata + dual-window empirical odds blend (read-only companion; no upstream equivalent).'
    )
    .argument('<packSlug>', 'Pack slug (e.g. eden-pack)')
    .option('--json', 'Output raw JSON envelope')
    .action(async (packSlug: string, opts: { json?: boolean }) => {
      try {
        const env = await runPackInfo(packSlug, {
          config: (await import('./config.ts')).loadConfig(),
          fetchImpl: deps.fetchImpl,
        });
        if (opts.json) {
          emit.json(env);
        } else {
          emit.pretty(formatPackInfo(env.data));
        }
      } catch (err) {
        emit.error(err);
        doExit(1);
      }
    });

  // -------------------------------------------------------------------------
  // packs (DEPRECATED alias for `gacha list`, retained for backward compat).
  //
  // Upstream removed the top-level `packs` verb in renaiss@0.0.3-beta.2 in
  // favor of `gacha list`. We keep the alias so existing skill invocations,
  // Discord commands, and shell aliases keep working until v0.1.0. Emits a
  // deprecation warning to stderr on every invocation.
  // -------------------------------------------------------------------------
  program
    .command('packs')
    .description(
      '[DEPRECATED] Alias for `pullcast gacha list`. Removed in v0.1.0.'
    )
    .argument('[slug]', 'Optional pack slug (e.g. eden-pack); when set, prints pack detail.')
    .option('--include-inactive', 'Include archived and soldout-or-restocking packs.')
    .option('--json', 'Output raw JSON envelope')
    .action(
      async (
        slug: string | undefined,
        opts: { includeInactive?: boolean; json?: boolean }
      ) => {
        process.stderr.write(
          "WARN: 'pullcast packs' is deprecated; use 'pullcast gacha list' " +
            "(mirrors renaiss@0.0.3+ verb tree). " +
            'This alias will be removed in v0.1.0.\n'
        );
        await gachaListHandler(slug, opts);
      }
    );

  // Show help when invoked with no args.
  program.action(() => {
    program.outputHelp();
  });

  // Reject unknown subcommands with a non-zero exit + help text on stderr.
  program.showHelpAfterError('(use `pullcast --help` for the full command list)');

  return program;
}

// ---------------------------------------------------------------------------
// Bootstrap (skipped when imported by tests)
// ---------------------------------------------------------------------------

// Both `import.meta.main` (Bun) and `import.meta.url === pathToFileURL(process.argv[1])`
// (Node) work for entry detection. We check the former first as a lightweight
// signal and fall back to argv equality.
function isEntry(): boolean {
  const anyMeta = import.meta as unknown as { main?: boolean };
  if (anyMeta.main === true) return true;
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const url = new URL(import.meta.url);
    return url.pathname === entry || url.pathname.endsWith(entry);
  } catch {
    return false;
  }
}

if (isEntry()) {
  const program = createProgram();
  program.parseAsync(process.argv).catch((err) => {
    emitError(err);
    process.exit(1);
  });
}
