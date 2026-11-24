import { Command, Option } from "commander";
import { handleConfig } from "./commands/config";
import { runDaemon } from "./commands/daemon";
import { runHome } from "./commands/home";
import { runInit } from "./commands/init";
import { runMuseExportCommand, runMuseQueryCommand } from "./commands/muse";
import { runServiceCommand } from "./commands/service";
import { runStatus } from "./commands/status";
import { runSyncCommand } from "./commands/sync";
import { runUninstall } from "./commands/uninstall";
import { getCliVersion } from "./infrastructure/runtime/cli-version";
import { isInteractiveTerminal } from "./infrastructure/ui/prompts";

const CLI_VERSION = getCliVersion();

export function createCli(): Command {
  const program = new Command();

  program
    .name("tokenarena")
    .description("Track token burn across AI coding tools")
    .version(CLI_VERSION)
    .showHelpAfterError()
    .showSuggestionAfterError()
    .helpCommand("help [command]", "Display help for command");

  // Default action: show help or error for unknown commands
  program.action(async () => {
    const userArgs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
    if (userArgs.length > 0) {
      program.error(`unknown command '${userArgs[0]}'`);
    }
    if (isInteractiveTerminal()) {
      await runHome(program);
      return;
    }
    program.help();
  });

  // init command
  program
    .command("init")
    .description("Initialize configuration with API key")
    .option("--api-url <url>", "Custom API server URL")
    .action(async (opts) => {
      await runInit(opts);
    });

  // sync command
  program
    .command("sync")
    .description("Manually sync usage data to server")
    .option(
      "--rebuild",
      "Replace this device's remote history; requires complete local logs",
    )
    .addOption(new Option("--quiet").hideHelp())
    .action(async (opts) => {
      await runSyncCommand(opts);
    });

  // daemon command
  program
    .command("daemon")
    .description("Run continuous sync (every 30 minutes by default)")
    .option("--interval <ms>", "Sync interval in milliseconds", parseInt)
    .addOption(new Option("--service").hideHelp())
    .action(async (opts) => {
      await runDaemon(opts);
    });

  // service command
  program
    .command("service [action]")
    .description(
      "Manage background service (setup|start|stop|restart|status|uninstall)",
    )
    .action(async (action) => {
      await runServiceCommand({ action });
    });

  // status command
  program
    .command("status")
    .description("Show configuration and detected tools")
    .option("--show", "Show interactive local usage dashboard")
    .action(async (opts) => {
      await runStatus(opts);
    });

  // config command (with subcommands)
  program
    .command("config")
    .description("Manage configuration")
    .argument("[subcommand]", "get|set|show")
    .argument("[key]", "Config key")
    .argument("[value]", "Config value")
    .allowUnknownOption(true)
    .action(async (subcommand, key, value) => {
      await handleConfig(
        [subcommand, key, value].filter(
          (item): item is string => typeof item === "string",
        ),
      );
    });

  // muse command (with subcommands): build the Muse usage export
  // from the Muse runtime database.
  const muse = program
    .command("muse")
    .description("Build the Muse usage export from the runtime database");
  muse
    .command("query")
    .description("Print the canonical SQL that reads Muse usage")
    .action(async () => {
      await runMuseQueryCommand();
    });
  muse
    .command("export")
    .description("Transform runtime database rows into the usage export file")
    .option(
      "--input <file>",
      "Read database rows (JSON or JSONL) from a file instead of stdin",
    )
    .option(
      "--output <file>",
      "Write the export to this file instead of the default export path",
    )
    .option(
      "--db",
      "Run the query directly with psql (libpq environment variables)",
    )
    .action(async (opts) => {
      await runMuseExportCommand(opts);
    });

  // uninstall command
  program
    .command("uninstall")
    .description("Remove all local configuration and data")
    .action(async () => {
      await runUninstall();
    });

  return program;
}
