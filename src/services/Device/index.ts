import CancelablePromise from "cancelable-promise"
import { EventEmitter } from "events"
import * as _ from "lodash"
import * as configuration from "../../configuration"
import logger from "../../helpers/Logger"
import ApiClient from "../ApiClient"
import { DeviceEvent, DeviceState } from "./types"

interface DeviceConstructorArgs {
  api: ApiClient
  name: string
  topic: string
  duration?: number
  durationDelta?: number
}

export default class Device extends EventEmitter {
  public readonly name: string
  public readonly topic: string
  public readonly duration: number
  public readonly delta: number
  private readonly api: ApiClient

  private percent = this.toPercent(configuration.somfy.initialPosition)
  private state = DeviceState.STOPPED
  private updateDeferred?: CancelablePromise

  constructor(args: DeviceConstructorArgs) {
    super()

    const duration = args.duration ?? configuration.somfy.defaultDuration
    const durationDelta = args.durationDelta ?? configuration.somfy.defaultDurationDelta
    const delta = duration / durationDelta

    this.api = args.api
    this.name = args.name
    this.topic = args.topic
    this.duration = duration
    this.delta = delta
  }

  public getPosition(): number {
    return this.toPosition(this.percent)
  }

  private toPosition(percent: number): number {
    if (percent === 0 || percent === 100) {
      return percent
    } else if (percent <= this.delta) {
      return 1
    }

    return percent - this.delta
  }

  private toPercent(position: number): number {
    if (position < 1) {
      return 0
    } else if (position === 1) {
      return this.delta
    }

    return Math.min(100, position + this.delta)
  }

  public getState(): DeviceState {
    return this.state
  }

  public touch(): void {
    this.api.init().catch((error) => {
      this.log("error", error)
    })
  }

  public async setPosition(position: number): Promise<void> {
    this.log("info", `setPosition: from ${this.getPosition()} to ${position}`)
    this.cancelUpdate()

    const percent = this.toPercent(position)
    const difference = percent - this.percent
    const direction = difference > 0 ? 1 : -1
    const ms = 1000
    const increment = (100 * ms * direction) / this.duration

    let handler: () => Promise<void>

    if (percent === 0) {
      handler = this.down
    } else if (percent === 100) {
      handler = this.up
    } else if (difference !== 0) {
      handler = difference > 0 ? this.up : this.down
    } else {
      return
    }

    if (difference === 0) {
      return handler.apply(this)
    }

    const deferred: CancelablePromise = (this.updateDeferred = new CancelablePromise<void>(
      async (resolve: () => void) => {
        await handler.apply(this)

        const interval = setInterval(() => {
          const nextValue = this.percent + increment
          const isEnded =
            deferred.isCanceled() ||
            (nextValue < percent && difference < 0) ||
            (nextValue > percent && difference > 0)

          if (isEnded) {
            clearInterval(interval)
            resolve()
          } else {
            this.handlePercentChange(nextValue)
          }
        }, ms)
      }
    ))

    await deferred.then(async () => {
      if (!deferred.isCanceled()) {
        await this.handlePercentChange(percent)
        await this.stop()
      }
    })
  }

  public async up(): Promise<void> {
    this.log("info", "action: up")
    this.handleStateChange(DeviceState.INCREASING)

    await this.api.action({
      action: "up",
      topic: this.topic,
    })
  }

  public async down(): Promise<void> {
    this.log("info", "action: down")
    this.handleStateChange(DeviceState.DECREASING)

    await this.api.action({
      action: "down",
      topic: this.topic,
    })
  }

  public async stop(): Promise<void> {
    this.handleStateChange(DeviceState.STOPPED)

    if (this.percent > 0 && this.percent < 100) {
      this.log("info", "action: stop")

      await this.api.action({
        action: "stop",
        topic: this.topic,
      })
    }
  }

  private cancelUpdate(): void {
    this.updateDeferred?.cancel()
  }

  private handlePercentChange(value: number) {
    this.percent = _.clamp(value, 0, 100)

    this.log("info", "percentChange", this.percent)
    this.emit(DeviceEvent.POSITION_CHANGE)
  }

  private handleStateChange(value: DeviceState): void {
    this.state = value

    this.log("info", "stateChange", value)
    this.emit(DeviceEvent.STATE_CHANGE, { value })
  }

  private log(level: "info" | "error", ...parameters: unknown[]): void {
    logger[level](`[${this.topic}]:`, ...parameters)
  }
}
