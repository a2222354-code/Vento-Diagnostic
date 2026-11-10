/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type ConnectionState = 
  | 'DISCONNECTED'
  | 'SEARCHING_USB'
  | 'USB_CONNECTED'
  | 'INIT_5BAUD'
  | 'SYNC_RECEIVED'
  | 'READING_TITLE'
  | 'CONNECTED'
  | 'ERROR';

export type OperatingMode = 'SIMULATOR' | 'USB_KKL';

export interface EcuIdentification {
  partNumber: string;       // e.g. "3A0 907 311" or "3A0 907 311 B"
  component: string;        // e.g. "1.8l R4 MONO 1.2.3 D30"
  coding: string;           // e.g. "00000"
  dealerCode: string;       // e.g. "WSC 00000"
  system: string;           // "Bosch Mono-Motronic 1.2.3"
  engineCode: string;       // "ADZ / ABS / AAM 1.8 8V"
  baudRate: number;         // 9600 bps
}

export interface DtcFault {
  code: string;             // 5-digit VAG DTC (e.g. "00515")
  hexCode: string;          // Hex e.g. "0203"
  component: string;        // "G40 Датчик Холла"
  description: string;      // "Нет сигнала / Обрыв цепи"
  status: 'active' | 'intermittent';
  statusText: string;       // "Спорадическая" | "Постоянная"
  cause: string;            // Описание причины
  remedy: string;           // Способ устранения и проверки
  isExpectedWhenStopped?: boolean; // 00515 всегда висит на незаведенном моторе
}

export interface MeasuringChannel {
  channelNumber: number;
  label: string;
  value: number;
  unit: string;
  rawValue: number;
  min: number;
  max: number;
  normalMin?: number;
  normalMax?: number;
  description: string;
  statusBadge?: string;
}

export interface MeasuringGroupData {
  groupNumber: number;
  title: string;
  description: string;
  channels: MeasuringChannel[];
  rawBytes?: number[];
}

export interface ActuatorTestItem {
  id: string;
  name: string;
  componentCode: string;
  description: string;
  durationSeconds: number;
  soundHint: string;
  instructions: string;
}

export interface ProtocolLogEntry {
  id: string;
  timestamp: string;
  direction: 'TX' | 'RX' | 'INFO' | 'ERR' | 'SUCCESS';
  rawBytes: number[];
  hexString: string;
  description: string;
  blockTitle?: string;
}

export interface EngineLiveState {
  rpm: number;
  coolantTemp: number;
  throttleAngle: number;
  lambdaVoltage: number;
  lambdaFactor: number;
  injectionTimeMs: number;
  intakeTemp: number;
  batteryVoltage: number;
  ignitionTimingDeg: number;
  idleSwitchClosed: boolean;
  isEngineRunning: boolean;
  basicSettingsActive: boolean;
}
