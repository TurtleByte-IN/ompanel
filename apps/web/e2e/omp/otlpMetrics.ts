// @effect-diagnostics nodeBuiltinImport:off - a loopback OTLP receiver for end-to-end tests.
// Receives the server's OTLP/HTTP JSON metric exports, so a test can read exactly the labels
// Ompanel would send to a collector.
import * as NodeHttp from "node:http";

export interface OtlpMetricPoint {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface OtlpMetricsReceiver {
  readonly url: string;
  /** Every data point received so far, in arrival order. */
  readonly points: () => ReadonlyArray<OtlpMetricPoint>;
  readonly close: () => Promise<void>;
}

interface OtlpValue {
  readonly stringValue?: string;
  readonly intValue?: string | number;
  readonly doubleValue?: number;
  readonly boolValue?: boolean;
}
interface OtlpDataPoint {
  readonly attributes?: ReadonlyArray<{ readonly key: string; readonly value: OtlpValue }>;
  readonly asInt?: string | number;
  readonly asDouble?: number;
  readonly count?: string | number;
}
interface OtlpMetric {
  readonly name: string;
  readonly sum?: { readonly dataPoints: ReadonlyArray<OtlpDataPoint> };
  readonly gauge?: { readonly dataPoints: ReadonlyArray<OtlpDataPoint> };
  readonly histogram?: { readonly dataPoints: ReadonlyArray<OtlpDataPoint> };
}
interface OtlpExport {
  readonly resourceMetrics?: ReadonlyArray<{
    readonly scopeMetrics?: ReadonlyArray<{ readonly metrics?: ReadonlyArray<OtlpMetric> }>;
  }>;
}

const valueText = (value: OtlpValue): string =>
  value.stringValue ??
  String(value.intValue ?? value.doubleValue ?? value.boolValue ?? JSON.stringify(value));

export const startOtlpMetricsReceiver = async (): Promise<OtlpMetricsReceiver> => {
  const received: Array<OtlpMetricPoint> = [];
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OtlpExport;
        for (const resource of body.resourceMetrics ?? []) {
          for (const scope of resource.scopeMetrics ?? []) {
            for (const metric of scope.metrics ?? []) {
              const points =
                metric.sum?.dataPoints ??
                metric.gauge?.dataPoints ??
                metric.histogram?.dataPoints ??
                [];
              for (const point of points) {
                received.push({
                  name: metric.name,
                  attributes: Object.fromEntries(
                    (point.attributes ?? []).map((entry) => [entry.key, valueText(entry.value)]),
                  ),
                  value: Number(point.asInt ?? point.asDouble ?? point.count ?? 0),
                });
              }
            }
          }
        }
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      } catch {
        response.writeHead(400).end();
      }
    });
  });
  const listening = Promise.withResolvers<number>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    listening.resolve(typeof address === "object" && address !== null ? address.port : 0);
  });
  const port = await listening.promise;
  return {
    url: `http://127.0.0.1:${port}/v1/metrics`,
    points: () => [...received],
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
};
