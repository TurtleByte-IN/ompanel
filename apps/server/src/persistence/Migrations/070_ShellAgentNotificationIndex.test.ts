import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("070_ShellAgentNotificationIndex", (it) => {
  it.effect("indexes agent notifications only, and the shell read does not depend on it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });
      const insert = (id: string, threadId: string, kind: string, updatedAt: string) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, ordinal, type, status, updated_at, payload_json
        )
        VALUES (
          ${id}, ${threadId}, NULL, NULL, 0, 'notification', 'completed', ${updatedAt},
          ${JSON.stringify({ source: { kind }, summary: id })}
        )
      `;
      // Rows written before the migration are covered once it runs.
      yield* insert("older", "thread-1", "agent", "2026-10-27T10:00:00.000Z");
      yield* insert("newer", "thread-1", "agent", "2026-10-27T10:05:00.000Z");
      yield* insert("system", "thread-1", "system", "2026-10-27T10:09:00.000Z");
      yield* insert("other-thread", "thread-2", "agent", "2026-10-27T10:10:00.000Z");

      const latest = () =>
        sql<{ readonly id: string }>`
          SELECT item.turn_item_id AS id
          FROM orchestration_v2_projection_turn_items item
          WHERE item.thread_id = 'thread-1'
            AND item.type = 'notification'
            AND json_extract(item.payload_json, '$.source.kind') = 'agent'
          ORDER BY item.updated_at DESC, item.turn_item_id DESC
          LIMIT 1
        `.pipe(Effect.map((rows) => rows.map((row) => row.id)));
      // Unprepared: a cached EXPLAIN statement keeps the plan it was prepared with after DROP INDEX.
      const plan = () =>
        sql
          .unsafe<{ readonly detail: string }>(
            `EXPLAIN QUERY PLAN
            SELECT item.payload_json
            FROM orchestration_v2_projection_turn_items item
            WHERE item.thread_id = 'thread-1'
              AND item.type = 'notification'
              AND json_extract(item.payload_json, '$.source.kind') = 'agent'
            ORDER BY item.updated_at DESC, item.turn_item_id DESC
            LIMIT 1`,
          )
          .unprepared.pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));
      const indexExists = () =>
        sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'orchestration_v2_projection_turn_items_agent_notification_idx'
        `.pipe(Effect.map((rows) => rows.length === 1));

      assert.deepEqual(yield* latest(), ["newer"]);
      assert.isFalse(yield* indexExists());

      // Up.
      assert.deepEqual(yield* runMigrations(), [[70, "ShellAgentNotificationIndex"]]);
      assert.isTrue(yield* indexExists());
      assert.include(
        yield* plan(),
        "orchestration_v2_projection_turn_items_agent_notification_idx",
      );
      assert.deepEqual(yield* latest(), ["newer"]);
      assert.deepEqual(yield* runMigrations(), []);

      // Down: the migration only adds an index, so dropping it restores the old schema and
      // the shell read keeps its answer.
      yield* sql`DROP INDEX orchestration_v2_projection_turn_items_agent_notification_idx`;
      assert.isFalse(yield* indexExists());
      assert.notInclude(
        yield* plan(),
        "orchestration_v2_projection_turn_items_agent_notification_idx",
      );
      assert.deepEqual(yield* latest(), ["newer"]);
    }),
  );
});
