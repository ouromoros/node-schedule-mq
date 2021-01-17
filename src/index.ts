import { parseExpression } from "cron-parser";
import ioredis from "ioredis";
import { v4 as uuid } from "uuid";
import { RedisBroker } from "./redis_impl";
import { Execution, parseExec } from "./struct";

interface Handler {
  (data?: string): boolean | Promise<boolean>;
}

interface SchedulerOptions {
  storageType: "redis";
  storageConfig: ioredis.RedisOptions;
}

interface ScheduleOptions {
  cronExpr: string;

  retry?: boolean;
  retryTimeout?: number;
}

interface FireOptions {
  data?: string;

  delay?: number;

  retry?: boolean;
  retryTimeout?: number;
}

enum Status {
  RUNNING,
  STOPPED,
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Scheduler {
  private registerMap: Record<string, ScheduleOptions>;
  private bindMap: Record<string, Handler>;
  private status: Status;
  private logger: Console;
  private broker: RedisBroker;

  constructor(redisConfig: ioredis.RedisOptions) {
    this.registerMap = {};
    this.bindMap = {};
    this.status = Status.STOPPED;
    this.logger = console;

    this.broker = new RedisBroker(redisConfig);
  }

  /**
   * Once `start()` is called, the scheduler would start scheduling registered tasks and listen for binded tasks
   */
  start() {
    this.status = Status.RUNNING;
    this.startSchedules();

    this.checkTimeoutTasks();
    this.checkBindTasks();
  }

  /**
   * Stop all actions including listen for tasks and schedule tasks
   */
  stop() {
    this.status = Status.STOPPED;
  }

  /**
   * Register a job to be scheduled according to cronExpr
   * @param taskId unique taskId for a task
   * @param options specify cronExpr and other strategies for scheduling
   */
  register(taskId: string, options: ScheduleOptions) {
    this.registerMap[taskId] = options;
  }

  /**
   * After bind a task to the scheduler, the scheduler will try to pull task from task queue with specified
   * `taskId` and take action specified by `handler`
   * @param taskId unique id of a task
   * @param handler specify action when task arrives
   */
  bind(taskId: string, handler: Handler) {
    this.bindMap[taskId] = handler;
  }

  /**
   * Push a task with `taskId` to task queue
   * @param taskId unique id of a task
   * @param opts specify additional data and retry stratigies
   */
  fire(taskId: string, opts: FireOptions) {
    const exec = {
      taskId,
      execId: uuid(),
      data: opts.data,
      retry: opts.retry,
      retryTimeout: opts.retryTimeout,
    };
    if (!opts.delay) {
      this.pushExecution(exec);
    } else {
      this.pushDelayed(exec, opts.delay);
    }
  }

  private async checkTimeoutTasks() {
    while (this.status === Status.RUNNING) {
      const exe = await this.broker.tpop();
      const execution = parseExec(exe);
      this.pushExecution(execution);
    }
  }

  private getBindTaskQueues() {
    return Object.keys(this.bindMap);
  }

  private async checkBindTasks() {
    while (this.status === Status.RUNNING) {
      const queues = this.getBindTaskQueues();
      const exe = await this.broker.rpop(queues);
      if (!exe) continue;
      const exec = parseExec(exe);
      this.doExec(exec);
    }
  }

  private async doExec(exec: Execution) {
    const handler = this.bindMap[exec.taskId];
    try {
      let success = handler(exec.data);
      if (success instanceof Promise) {
        success = await success;
      }
      if (!success) {
        throw new Error("task failed");
      }
      if (exec.retry) {
        this.broker.clearTimeout(exec.execId);
      }
    } catch (e) {
      this.logger.error(e);
    }
  }

  private pushExecution(execution: Execution) {
    this.broker.rpush(execution);
  }

  private pushDelayed(exec: Execution, delay: number) {
    const timeStamp = Date.now() + delay;
    this.broker.tpush(timeStamp, exec);
  }

  private async startSchedule(taskId: string, options: ScheduleOptions) {
    const cron = parseExpression(options.cronExpr);
    let nextTime = cron.next().getTime();
    while (this.status === Status.RUNNING && nextTime) {
      await sleep(nextTime - Date.now());
      const execId = `sched:${taskId}:${nextTime}`;
      const exec = {
        taskId,
        execId,
        retry: options.retry,
        retryTimeout: options.retryTimeout,
      };
      const success = await this.broker.lockAndAddTimeout(exec, 1000);
      if (success) {
        this.pushExecution(exec);
      }
      nextTime = cron.next().getTime();
    }
  }

  private startSchedules() {
    for (const taskId in this.registerMap) {
      this.startSchedule(taskId, this.registerMap[taskId]);
    }
  }
}

export function createScheduler(opts: SchedulerOptions) {
  return new Scheduler(opts.storageConfig);
}