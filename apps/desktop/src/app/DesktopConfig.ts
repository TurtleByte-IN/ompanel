import { OtlpHeadersFromString, OtlpProtocol } from "@t3tools/shared/observability";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  Config.Boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  t3Home: trimmedString("OMPANEL_HOME"),
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedString("OMPANEL_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteT3ServerEntryPath: trimmedString("OMPANEL_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.Port("OMPANEL_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("OMPANEL_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("OMPANEL_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("OMPANEL_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: trimmedString("OMPANEL_OTLP_TRACES_URL"),
  otlpMetricsUrl: trimmedString("OMPANEL_OTLP_METRICS_URL"),
  otlpLogsUrl: trimmedString("OMPANEL_OTLP_LOGS_URL"),
  otlpExportIntervalMs: Config.Int("OMPANEL_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "OMPANEL_OTLP_HEADERS").pipe(Config.option),
  otlpProtocol: Config.schema(OtlpProtocol, "OMPANEL_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  desktopLauncherPath: trimmedString("OMPANEL_DESKTOP_LAUNCHER_PATH"),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBoolean("OMPANEL_DISABLE_AUTO_UPDATE"),
  mockUpdates: optionalBoolean("OMPANEL_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.Port("OMPANEL_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
