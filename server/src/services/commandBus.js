import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub that wakes a device's held (long-poll) check-in the instant
 * a command is queued for it, instead of making it wait for the next scheduled
 * poll. The API server and the command-issuing code run in the same process, so
 * a plain EventEmitter is all this needs — no external broker, no FCM.
 */
const bus = new EventEmitter();
// One held check-in per online device means listener count scales with the
// fleet; lift Node's default 10-listener warning cap.
bus.setMaxListeners(0);

/** Signal any check-in currently long-polling for this device. */
export function notifyCommand(deviceId) {
  bus.emit(`cmd:${deviceId}`);
}

/**
 * Resolve `true` as soon as a command is queued for `deviceId`, or `false` after
 * `timeoutMs`. Resolves early with `false` if the *response* stream `res` closes
 * (client disconnected mid-poll), so a device that drops never leaks a listener
 * or timer. `timeoutMs <= 0` resolves immediately (long-poll disabled).
 *
 * We watch `res`, not `req`: Node fires 'close' on the request stream as soon as
 * its body has been consumed (and sets req.destroyed), which would resolve this
 * the instant it started. The response stream's 'close' only fires when the
 * connection actually terminates, which is the signal we want.
 */
export function waitForCommand(deviceId, timeoutMs, res) {
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const evt = `cmd:${deviceId}`;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bus.off(evt, onCmd);
      res?.off?.('close', onClose);
      resolve(val);
    };
    const onCmd = () => finish(true);
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    bus.once(evt, onCmd);
    res?.once?.('close', onClose);
  });
}
