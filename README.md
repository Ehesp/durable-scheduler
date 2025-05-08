# Durable Scheduler

A scheduler built on-top of Cloudflare Workers Durable Objects.

Heavily inspired by [partywhen](https://github.com/cloudflare/partykit/tree/main/packages/partywhen).

## Usage

Install the package:

```
npm i --save cf-durable-scheduler
```

Next, create your own class which extends the `DurableScheduler`:

```ts
// index.ts
import { DurableScheduler } from 'cf-durable-scheduler';

export class MyScheduler extends DurableScheduler<Env> {
  async onScheduledTask(task: Task): Promise<void> {
    // ...
  }
}
```

Within your wrangler configuration file, add a rule for `.sql` files alongwith your Durable Object export:

```toml
rules = [
  { type = "Text", globs = ["**/*.sql"], fallthrough = true }
]

[[durable_objects.bindings]]
name = "MY_SCHEDULER"
class_name = "MyScheduler"

[[migrations]]
tag = "v1"
new_sqlite_classes = [ "MyScheduler" ]
```

Within your application, create a task via the Durable Object stub:

```ts
const id = env.MY_SCHEDULER.idFromName(`123`);
const stub = env.MY_SCHEDULER.get(id);

await stub.createTask({
  description: 'My scheduled task',
  type: 'scheduled',
  date: new Date(Date.now() + 60_000), // Schedule something for 1 min from now
  payload: {
    hello: 'world',
  },
});
```

You can now handle the tasks in your class:

```ts
export class MyScheduler extends DurableScheduler<Env> {
  async onScheduledTask(task: Task): Promise<void> {
    console.log('Got a task to handle!', task.payload);
  }
}
```

## Task types

**Cron**: 

Triggers a task on a cron expression:

```js
{
  type: 'cron',
  cron: '* * * * *',
}
```

**Delayed**:

Triggers a task to run in a specified amount of seconds:

```js
{
  type: 'delayed',
  seconds: 40,
}
```

**Scheduled**:

Triggers a task to run at a specific date:

```js
{
  type: 'scheduled',
  date: new Date(Date.now() + 60_000),
}
```

**No Schedule**:

Creates a task which much be trigger manually (via `runTask(id)`):

```js
{
  type: 'no-schedule',
}
```

## API

- `createTask(schedule)`: Creates a task and returns its unique ID.
- `countTasks(query)`: Counts the number of pending scheduled tasks.
- `cancelTask(id)`: Cancels a task by ID, and returns a boolean if the ID was found.
- `getTask(id)`: Gets a task by ID, or null if it does not exist.
- `updateTask(id)`: Update a task, and returns a boolean if the ID was found.
- `queryTasks(query)`: Queries tasks by given filters.
- `runTask(id)`: Force runs a task.