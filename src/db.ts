import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * This is the database schema for the Durable Object which runs the scheduler, hence it
 * being in its own file, as the DO runs any migrations when it's accessed.
 */

export const TASK_TYPES = [
	'scheduled',
	'delayed',
	'cron',
	'no-schedule',
] as const;

export const tasks = sqliteTable('tasks', {
	id: text('id').primaryKey(),
	description: text('description'),
	payload: text('payload', {
		mode: 'json',
	}).$type<Record<string, unknown>>(),
	type: text('type', {
		enum: TASK_TYPES,
	}).notNull(),
	date: integer('date', {
		mode: 'timestamp_ms',
	}),
	delayInSeconds: integer('delayInSeconds', {
		mode: 'number',
	}),
	cron: text('cron'),
	createdAt: integer('created_at', {
		mode: 'timestamp_ms',
	}).default(sql`(unixepoch())`),
}, (table) => ({
	// Index for queries that filter by type and sort by date
	typeDateIdx: index('type_date_idx').on(table.type, table.date),
	// Index for queries that sort by date
	dateIdx: index('date_idx').on(table.date),
}));

export type Task<T extends Record<string, unknown> = Record<string, unknown>> = typeof tasks.$inferSelect & {
	payload: T | null;
};