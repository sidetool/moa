export type SourceLane = 'background' | 'interactive' | 'exclusive';
interface Job { lane: SourceLane; start: () => void }
interface Queue { jobs: Job[]; active: Set<SourceLane>; idle: (() => void)[] }
/** One list lane and one reserved page/player lane; management operations exclude both. */
export class SourceQueue {
  private queues = new Map<string, Queue>();
  run<T>(id: string, lane: SourceLane, task: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(id) || { jobs: [], active: new Set<SourceLane>(), idle: [] };
    if (queue.jobs.filter(job => job.lane === lane).length + Number(queue.active.has(lane)) >= 8) return Promise.reject(new Error('source-busy'));
    this.queues.set(id, queue);
    return new Promise<T>((resolve, reject) => {
      queue.jobs.push({ lane, start: () => {
        queue.active.add(lane);
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          queue.active.delete(lane); this.pump(id, queue);
        });
      } });
      this.pump(id, queue);
    });
  }
  private pump(id: string, queue: Queue): void {
    if (queue.active.has('exclusive')) return;
    // Do not let later reads bypass a pending settings/install operation.
    const barrier = queue.jobs.findIndex(job => job.lane === 'exclusive');
    if (barrier === 0) {
      if (!queue.active.size) queue.jobs.shift()!.start();
      return;
    }
    for (const lane of ['interactive', 'background'] as const) {
      if (queue.active.has(lane)) continue;
      const index = queue.jobs.findIndex((job, i) => job.lane === lane && (barrier < 0 || i < barrier));
      if (index >= 0) { queue.jobs.splice(index, 1)[0].start(); return this.pump(id, queue); }
    }
    if (!queue.active.size && !queue.jobs.length) {
      this.queues.delete(id); queue.idle.forEach(resolve => resolve());
    }
  }
  async drain(id?: string) {
    await Promise.all([...this.queues].filter(([key]) => !id || key === id).map(([,queue]) => new Promise<void>(resolve => queue.idle.push(resolve))));
  }
}
