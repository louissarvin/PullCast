/**
 * Barrel of registered slash commands. index.ts imports this once.
 *
 * To add a new command: create a file in this directory that exports a
 * `Command` object, then add it to `ALL_COMMANDS` below.
 */

import type { Command } from '../command-registry.ts';
import { pullcastCommand } from './pullcast.ts';
import { helpCommand } from './help.ts';
import { priceCommand } from './price.ts';
import { oddsCommand } from './odds.ts';
import { explainCommand } from './explain.ts';
import { listingCommand } from './listing.ts';
import { leaderboardCommand } from './leaderboard.ts';
import { valuateCommand } from './valuate.ts';
import { marketCommand } from './market.ts';
import { featuredCommand } from './featured.ts';
import { profileCommand } from './profile.ts';
import { browseCommand } from './browse.ts';
import { alertsCommand } from './alerts.ts';
import { reportCommand } from './report.ts';
import { packsCommand } from './packs.ts';
import { setCommand } from './set.ts';
import { tradesCommand } from './trades.ts';
import { searchCommand } from './search.ts';
import { renaissCommand } from './renaiss.ts';

export const ALL_COMMANDS: Command[] = [
  pullcastCommand,
  helpCommand,
  renaissCommand,
  priceCommand,
  oddsCommand,
  explainCommand,
  listingCommand,
  leaderboardCommand,
  valuateCommand,
  marketCommand,
  featuredCommand,
  tradesCommand,
  searchCommand,
  profileCommand,
  browseCommand,
  alertsCommand,
  reportCommand,
  packsCommand,
  setCommand,
];

export {
  pullcastCommand,
  helpCommand,
  priceCommand,
  oddsCommand,
  explainCommand,
  listingCommand,
  leaderboardCommand,
  valuateCommand,
  marketCommand,
  featuredCommand,
  profileCommand,
  browseCommand,
  alertsCommand,
  reportCommand,
  packsCommand,
  setCommand,
  tradesCommand,
  searchCommand,
  renaissCommand,
};
