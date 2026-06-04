/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Fluncle CLI Path - Absolute path to the fluncle executable. */
  "flunclePath": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `quick-add` command */
  export type QuickAdd = ExtensionPreferences & {}
  /** Preferences accessible in the `add-track` command */
  export type AddTrack = ExtensionPreferences & {}
  /** Preferences accessible in the `recent-tracks` command */
  export type RecentTracks = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `quick-add` command */
  export type QuickAdd = {}
  /** Arguments passed to the `add-track` command */
  export type AddTrack = {}
  /** Arguments passed to the `recent-tracks` command */
  export type RecentTracks = {}
}

