import { DurableObject } from "cloudflare:workers";
import { drizzle, DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { CronExpressionParser } from "cron-parser";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { eq, and, gt, asc, ne, lte, count } from "drizzle-orm";
import { type Task, tasks } from "./db";

import migrations from "./migrations/migrations";

export type BaseSchedule = {
  // The id of the schedule, defaults to a random UUID.
  id?: string;
  // The description of the schedule.
  description: Task["description"];
  // The payload of the schedule.
  payload?: Record<string, unknown>;
};

export type CronSchedule = BaseSchedule & {
  // A cron schedule.
  type: "cron";
  // The cron expression to schedule the task.
  cron: string;
};

export type DelayedSchedule = BaseSchedule & {
  // A delayed schedule.
  type: "delayed";
  // The number of seconds to delay the task.
  seconds: number;
};

export type ScheduledSchedule = BaseSchedule & {
  // A datetime schedule.
  type: "scheduled";
  // The datetime to schedule the task.
  date: Date;
};

export type NoSchedule = BaseSchedule & {
  type: "no-schedule";
};

export type Schedule =
  | CronSchedule
  | DelayedSchedule
  | ScheduledSchedule
  | NoSchedule;

export type QueryOptions = {
  // The limit of the number of tasks to return, defaults to 100.
  limit?: number;
  // The offset of the tasks to return, defaults to 0.
  offset?: number;
  // The order of the tasks to return by date, defaults to descending.
  orderBy?: "asc" | "desc";
  // The type of the tasks to return, defaults to all types.
  type?: Task["type"];
};

// The schema of the DO database for Drizzle.
const schema = { tasks };

export abstract class DurableScheduler<Env> extends DurableObject<Env> {
  // The storage for the DO
  storage: DurableObjectStorage;
  // The Drizzle database for the DO.
  db: DrizzleSqliteDODatabase<typeof schema>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.storage = state.storage;
    this.db = drizzle(this.storage, { logger: false, schema });

    state.blockConcurrencyWhile(async () => {
      await this.migrate();
      await this.alarm();
    });
  }

  // Returns the status of the scheduler.
  async status() {
    return {
      status: "reachable" as const,
      timestamp: Date.now(),
      diskUsage: this.storage.sql.databaseSize,
      tasks: await this.countTasks(),
    };
  }

  // Migrates the database to the latest version.
  private async migrate() {
    await migrate(this.db, migrations);
  }

  // Schedules the next alarm.
  private async scheduleNextAlarm() {
    // Get the next task to execute.
    const [nextTask] = await this.db
      .select({
        date: tasks.date,
      })
      .from(tasks)
      .where(and(gt(tasks.date, new Date()), ne(tasks.type, "no-schedule")))
      .orderBy(asc(tasks.date))
      .limit(1);

    const nextDate = nextTask?.date;

    if (!nextDate) {
      console.log("No next task, no alarm scheduled");
      return;
    }

    console.log(`Scheduling alarm for ${nextDate.toLocaleString()}`);
    await this.ctx.storage.setAlarm(nextDate);
  }

  // Returns the next cron time for the given cron expression.
  private getNextCronTime(cronExpression: string): Date {
    const interval = CronExpressionParser.parse(cronExpression);
    return interval.next().toDate();
  }

  // Executes all expired tasks which need to be executed.
  async alarm(): Promise<void> {
    console.log("Executing alarm");

    // Get all expired tasks which need to be executed.
    const expired = await this.db
      .select()
      .from(tasks)
      .where(and(lte(tasks.date, new Date()), ne(tasks.type, "no-schedule")));

    console.log(`Executing ${expired.length} expired tasks`);

    const results = await Promise.allSettled(
      expired.map(async (task) => {
        let error: Error | undefined;

        // Keep the error in the result.
        await this.onScheduledTask(task).catch((e) => {
          error = e;
        });

        if (task.type === "cron" && task.cron) {
          await this.db
            .update(tasks)
            .set({
              date: this.getNextCronTime(task.cron),
            })
            .where(eq(tasks.id, task.id));
        } else {
          await this.db.delete(tasks).where(eq(tasks.id, task.id));
        }

        return { id: task.id, error };
      })
    );

    // If any tasks threw an uncaught error - log them out here.
    if (results.filter((r) => r.status === "rejected").length > 0) {
      console.error(
        `Failed to execute ${
          results.filter((r) => r.status === "rejected").length
        } tasks`
      );
    }

    // If any tasks failed calling `onSchedule`, log them out here.
    const failed = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((r) => r.error);
    if (failed.length > 0) {
      console.error(
        `Failed to execute ${failed.length} tasks\n\n: ${failed
          .map((f) => `  ${f.id}: ${f.error}`)
          .join("\n")}`
      );
    }

    // Schedule the next alarm
    await this.scheduleNextAlarm();
  }

  // Creates a new schedule.
  public async createTask(schedule: Schedule): Promise<string> {
    const id = schedule.id || crypto.randomUUID();
    let record: Task | undefined;

    if (schedule.type === "cron") {
      [record] = await this.db
        .insert(tasks)
        .values({
          id,
          description: schedule.description,
          type: schedule.type,
          cron: schedule.cron,
          payload: schedule.payload,
        })
        .returning();
    } else if (schedule.type === "delayed") {
      [record] = await this.db
        .insert(tasks)
        .values({
          id,
          description: schedule.description,
          type: schedule.type,
          date: new Date(Date.now() + schedule.seconds * 1000),
          delayInSeconds: schedule.seconds,
          payload: schedule.payload ?? {},
        })
        .returning();
    } else if (schedule.type === "scheduled") {
      [record] = await this.db
        .insert(tasks)
        .values({
          id,
          description: schedule.description,
          type: schedule.type,
          date: schedule.date,
          payload: schedule.payload,
        })
        .returning();
    } else if (schedule.type === "no-schedule") {
      [record] = await this.db
        .insert(tasks)
        .values({
          id,
          description: schedule.description,
          type: schedule.type,
          payload: schedule.payload,
        })
        .returning();
    }

    if (!record) {
      throw new Error("Failed to create task");
    }

    await this.scheduleNextAlarm();
    console.log(`Created task: ${JSON.stringify(record)}`);
    return record.id;
  }

  // Counts the number of tasks.
  async countTasks(query?: { type?: Task["type"] }) {
    return this.db
      .select({ count: count() })
      .from(tasks)
      .where(query?.type ? eq(tasks.type, query.type) : undefined)
      .then((r) => r[0].count);
  }

  // Cancels a schedule by ID.
  // Returns a boolean value if the scheduled task existed.
  async cancelTask(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(tasks)
      .where(eq(tasks.id, id))
      .returning();
    await this.scheduleNextAlarm();
    return deleted.length > 0;
  }

  // Gets a task by ID.
  async getTask(id: string): Promise<Task | null> {
    const [task] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return task ?? null;
  }

  // Updates a task by ID.
  // Returns a boolean value if the scheduled task existed.
  async updateTask(
    id: string,
    task: Omit<Task, "id" | "createdAt">
  ): Promise<boolean> {
    const updated = await this.db
      .update(tasks)
      .set(task)
      .where(eq(tasks.id, id))
      .returning();
    await this.scheduleNextAlarm();
    return updated.length > 0;
  }

  // Queries the tasks with the given options.
  async queryTasks(query?: QueryOptions): Promise<Task[]> {
    return this.db.query.tasks.findMany({
      limit: query?.limit ?? 100,
      offset: query?.offset,
      orderBy: (tasks, { asc, desc }) => [
        query?.orderBy === "asc" ? asc(tasks.date) : desc(tasks.date),
      ],
      where: (tasks, { eq }) =>
        query?.type ? eq(tasks.type, query.type) : undefined,
    });
  }

  // Runs a task by ID, even if it's not due to run.
  async runTask(id: string): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) return false;
    await this.onScheduledTask(task);
    return true;
  }

  // Scheduled task execution handler.
  abstract onScheduledTask(task: Task): Promise<void>;
}
