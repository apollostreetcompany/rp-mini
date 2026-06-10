import EventEmitter from "events";

export class TaskStore extends EventEmitter {
  constructor() {
    super();
    this.tasks = [];
  }

  add(task) {
    this.tasks.push(task);
  }

  get count() {
    return this.tasks.length;
  }
}

export function normalizeTask(input) {
  return String(input).trim();
}

export const createTask = (title) => ({ title });
