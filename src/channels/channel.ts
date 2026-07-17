/**
 * An approval channel: subscribes to the broker's pending feed on start(),
 * settles calls via broker.decide(). Telegram, Discord, and the web UI all
 * speak this shape.
 */
export interface Channel {
  start(): void;
  stop(): void;
}
