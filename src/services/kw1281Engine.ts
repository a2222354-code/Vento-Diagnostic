/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ConnectionState,
  DtcFault,
  EcuIdentification,
  EngineLiveState,
  MeasuringGroupData,
  OperatingMode,
  ProtocolLogEntry
} from '../types/kw1281';
import {
  DEFAULT_ECU_VENTO,
  MONO_MOTRONIC_DTCS,
  generateMeasuringGroups
} from './vagData';

export type LogListener = (entry: ProtocolLogEntry) => void;
export type StateListener = (state: ConnectionState) => void;
export type EngineListener = (engine: EngineLiveState) => void;
export type GroupsListener = (groups: MeasuringGroupData[]) => void;
export type DtcListener = (dtcs: DtcFault[]) => void;

export class Kw1281Engine {
  private mode: OperatingMode = 'SIMULATOR';
  private state: ConnectionState = 'DISCONNECTED';
  private port: any = null;
  private reader: any = null;
  private writer: any = null;
  private isConnecting: boolean = false;
  private blockCounter: number = 0;

  // Active listeners
  private logListeners: Set<LogListener> = new Set();
  private stateListeners: Set<StateListener> = new Set();
  private engineListeners: Set<EngineListener> = new Set();
  private groupsListeners: Set<GroupsListener> = new Set();
  private dtcListeners: Set<DtcListener> = new Set();

  // Engine Physics & Simulator State
  private engineState: EngineLiveState = {
    rpm: 0,
    coolantTemp: 22,
    throttleAngle: 0.0,
    lambdaVoltage: 0.45,
    lambdaFactor: 1.00,
    injectionTimeMs: 0.0,
    intakeTemp: 20,
    batteryVoltage: 12.4,
    ignitionTimingDeg: 6.0,
    idleSwitchClosed: true,
    isEngineRunning: false,
    basicSettingsActive: false
  };

  private simInterval: any = null;
  private simAngle: number = 0;

  // Active DTCs
  private activeDtcs: DtcFault[] = [
    {
      ...MONO_MOTRONIC_DTCS['00515'],
      status: 'active',
      statusText: 'Постоянная (двигатель заглушен)'
    },
    {
      ...MONO_MOTRONIC_DTCS['00525'],
      status: 'intermittent',
      statusText: 'Спорадическая'
    }
  ];

  public ecuInfo: EcuIdentification = { ...DEFAULT_ECU_VENTO };

  constructor() {
    this.startSimulationLoop();
  }

  public getMode(): OperatingMode {
    return this.mode;
  }

  public setMode(newMode: OperatingMode) {
    if (this.mode === newMode) return;
    this.disconnect();
    this.mode = newMode;
    this.addLog(
      'INFO',
      [],
      `Режим работы переключен на: ${newMode === 'SIMULATOR' ? 'Эмуляция ЭБУ Mono-Motronic 1.2.3' : 'Реальный адаптер KKL USB FT232'}`
    );
  }

  public getState(): ConnectionState {
    return this.state;
  }

  public getEngineState(): EngineLiveState {
    return { ...this.engineState };
  }

  public getActiveDtcs(): DtcFault[] {
    return [...this.activeDtcs];
  }

  public onLog(cb: LogListener) {
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }

  public onState(cb: StateListener) {
    this.stateListeners.add(cb);
    cb(this.state);
    return () => this.stateListeners.delete(cb);
  }

  public onEngine(cb: EngineListener) {
    this.engineListeners.add(cb);
    cb(this.engineState);
    return () => this.engineListeners.delete(cb);
  }

  public onGroups(cb: GroupsListener) {
    this.groupsListeners.add(cb);
    cb(generateMeasuringGroups(this.engineState));
    return () => this.groupsListeners.delete(cb);
  }

  public onDtcs(cb: DtcListener) {
    this.dtcListeners.add(cb);
    cb(this.activeDtcs);
    return () => this.dtcListeners.delete(cb);
  }

  private setState(newState: ConnectionState) {
    this.state = newState;
    this.stateListeners.forEach((cb) => cb(newState));
  }

  private addLog(
    direction: ProtocolLogEntry['direction'],
    bytes: number[],
    description: string,
    blockTitle?: string
  ) {
    const entry: ProtocolLogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString('ru-RU', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
      }),
      direction,
      rawBytes: bytes,
      hexString: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
      description,
      blockTitle
    };
    this.logListeners.forEach((cb) => cb(entry));
  }

  // ==========================================
  // PHYSICAL USB & SERIAL API HANDLING
  // ==========================================

  public async connect(): Promise<boolean> {
    if (this.isConnecting || this.state === 'CONNECTED') return true;
    this.isConnecting = true;

    try {
      if (this.mode === 'SIMULATOR') {
        return await this.connectSimulator();
      } else {
        return await this.connectPhysicalUsb();
      }
    } finally {
      this.isConnecting = false;
    }
  }

  private async connectSimulator(): Promise<boolean> {
    this.setState('SEARCHING_USB');
    this.addLog('INFO', [], 'Поиск подключенных USB устройств (FTDI FT232RL)...');
    await this.delay(400);

    this.setState('USB_CONNECTED');
    this.addLog(
      'SUCCESS',
      [0x04, 0x03, 0x60, 0x01],
      'USB Адаптер обнаружен: FTDI FT232R USB UART [VID: 0x0403, PID: 0x6001]'
    );
    await this.delay(500);

    this.setState('INIT_5BAUD');
    this.addLog(
      'TX',
      [0x01],
      'Формирование 5-бодовой посылки адреса 0x01 (ЭБУ Двигателя). Тайминг: 2000 мс (10 бит по 200мс)'
    );
    await this.delay(2000);

    this.setState('SYNC_RECEIVED');
    this.addLog(
      'RX',
      [0x55],
      'Принят байт синхронизации 0x55 (Sync Byte). Скорость синхронизирована: 9600 бод'
    );
    await this.delay(250);

    this.addLog('RX', [0x01, 0x8A], 'Приняты ключевые байты: KB1 = 0x01 (KW1281), KB2 = 0x8A');
    await this.delay(100);

    // Complement response
    const complement = 0xff ^ 0x8a; // 0x75
    this.addLog(
      'TX',
      [complement],
      `Отправка инвертированного ответа (ACK): 0x${complement.toString(16).toUpperCase()}`
    );
    await this.delay(300);

    this.setState('READING_TITLE');
    // Title 1: Part Number
    const partNumBytes = Array.from(new TextEncoder().encode('3A0907311B'));
    this.addLog(
      'RX',
      [partNumBytes.length + 3, 0x00, 0xf6, ...partNumBytes, 0x03],
      'Блок идентификации 1: Номер детали VAG = 3A0 907 311 B'
    );
    await this.delay(200);

    // Title 2: Component
    const compBytes = Array.from(new TextEncoder().encode('1.8l R4 MONO 1.2.3 D30'));
    this.addLog(
      'RX',
      [compBytes.length + 3, 0x01, 0xf6, ...compBytes, 0x03],
      'Блок идентификации 2: Система = 1.8l R4 MONO 1.2.3 D30'
    );
    await this.delay(200);

    // Title 3: Coding
    const codeBytes = Array.from(new TextEncoder().encode('Coding 00000 WSC 01317'));
    this.addLog(
      'RX',
      [codeBytes.length + 3, 0x02, 0xf6, ...codeBytes, 0x03],
      'Блок идентификации 3: Кодировка = 00000, Код мастерской = WSC 01317'
    );
    await this.delay(200);

    this.setState('CONNECTED');
    this.addLog(
      'SUCCESS',
      [],
      'Сессия KW1281 успешно установлена! ЭБУ готов к приёму диагностических команд.'
    );

    this.broadcastEngine();
    return true;
  }

  private async connectPhysicalUsb(): Promise<boolean> {
    if (!('serial' in navigator)) {
      this.setState('ERROR');
      this.addLog(
        'ERR',
        [],
        'Браузер не поддерживает Web Serial API. Откройте в Chrome на Android (или включите chrome://flags/#enable-web-serial).'
      );
      return false;
    }

    try {
      this.setState('SEARCHING_USB');
      this.addLog('INFO', [], 'Запрос доступа к USB-порту через Web Serial...');

      // FTDI VID = 0x0403, PID = 0x6001, 0x6010, 0x6014, 0x6015
      const serial = (navigator as any).serial;
      this.port = await serial.requestPort({
        filters: [
          { usbVendorId: 0x0403 },
          { usbVendorId: 0x1a86 }, // CH340
          { usbVendorId: 0x10c4 }  // CP2102
        ]
      });

      const info = this.port.getInfo ? this.port.getInfo() : {};
      const vid = info.usbVendorId ? `0x${info.usbVendorId.toString(16)}` : '0x0403';
      const pid = info.usbProductId ? `0x${info.usbProductId.toString(16)}` : '0x6001';

      this.setState('USB_CONNECTED');
      this.addLog('SUCCESS', [], `USB порт открыт: VID ${vid}, PID ${pid}.`);

      // 5-baud address 0x01 bit sequence implementation via break signal
      this.setState('INIT_5BAUD');
      this.addLog('TX', [0x01], 'Выполнение 5-бодовой инициализации (200ms per bit)...');

      // First open port at 9600 to enable line control
      await this.port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });

      // Send 5-baud pattern using setSignals break condition:
      // Bit 0 = Start bit (Break = true for 200ms)
      await this.port.setSignals({ break: true });
      await this.delay(200);

      // Address 0x01 = 0b0000001. LSB first:
      // Bit 1: Data 1 -> Break = false
      await this.port.setSignals({ break: false });
      await this.delay(200);

      // Bit 2..7: Data 0 -> Break = true
      for (let i = 0; i < 6; i++) {
        await this.port.setSignals({ break: true });
        await this.delay(200);
      }

      // Parity bit (Odd parity for 0x01): 1 count of ones -> parity bit is 0 -> Break = true
      await this.port.setSignals({ break: true });
      await this.delay(200);

      // Stop bit: Mark (1) -> Break = false
      await this.port.setSignals({ break: false });
      await this.delay(200);

      this.setState('SYNC_RECEIVED');
      this.addLog('INFO', [], 'Ожидание ответа ЭБУ (байт синхронизации 0x55)...');

      // Start reading
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();

      // Read response loop
      this.readPhysicalLoop();

      return true;
    } catch (err: any) {
      this.setState('ERROR');
      this.addLog('ERR', [], `Ошибка подключения USB: ${err.message || String(err)}`);
      return false;
    }
  }

  private async readPhysicalLoop() {
    try {
      while (this.port && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length > 0) {
          const bytes = Array.from(value as Uint8Array);
          this.addLog('RX', bytes, `Принято ${bytes.length} байт`);
          this.handleIncomingRawBytes(bytes);
        }
      }
    } catch (e: any) {
      this.addLog('ERR', [], `Ошибка чтения потока: ${e.message}`);
    }
  }

  private handleIncomingRawBytes(bytes: number[]) {
    if (this.state === 'SYNC_RECEIVED') {
      if (bytes.includes(0x55)) {
        this.addLog('RX', [0x55], 'Обнаружен Sync Byte 0x55! Скорость подтверждена: 9600');
        this.setState('READING_TITLE');
      }
    }
  }

  public async disconnect() {
    if (this.mode === 'USB_KKL' && this.port) {
      try {
        if (this.reader) {
          await this.reader.cancel();
          this.reader.releaseLock();
          this.reader = null;
        }
        if (this.writer) {
          await this.writer.releaseLock();
          this.writer = null;
        }
        await this.port.close();
      } catch (e) {
        console.error('Error closing port', e);
      }
      this.port = null;
    }
    this.setState('DISCONNECTED');
    this.addLog('INFO', [], 'Связь с блоком управления завершена.');
  }

  // ==========================================
  // DIAGNOSTIC COMMANDS
  // ==========================================

  public async readFaultCodes(): Promise<DtcFault[]> {
    if (this.state !== 'CONNECTED') {
      throw new Error('Нет активной связи с ЭБУ. Сначала подключитесь.');
    }

    this.addLog(
      'TX',
      [0x03, ++this.blockCounter, 0x07, 0x03],
      'Запрос памяти неисправностей (Команда 0x07 - Read Fault Codes)'
    );
    await this.delay(350);

    // If engine is not running, 00515 is always in memory for Mono-Motronic 1.2.3!
    const updatedDtcs: DtcFault[] = [];

    if (!this.engineState.isEngineRunning) {
      updatedDtcs.push({
        ...MONO_MOTRONIC_DTCS['00515'],
        status: 'active',
        statusText: 'Постоянная (двигатель заглушен)'
      });
    }

    // Keep other active non-515 faults
    this.activeDtcs.forEach((d) => {
      if (d.code !== '00515') {
        updatedDtcs.push(d);
      }
    });

    this.activeDtcs = updatedDtcs;

    // Send RX block log for each DTC
    for (const dtc of this.activeDtcs) {
      const codeNum = parseInt(dtc.code, 10);
      const highByte = (codeNum >> 8) & 0xff;
      const lowByte = codeNum & 0xff;
      this.addLog(
        'RX',
        [0x06, ++this.blockCounter, 0xfc, highByte, lowByte, 0x00, 0x03],
        `DTC ${dtc.code} — ${dtc.component} (${dtc.description})`
      );
      await this.delay(100);
    }

    // End of DTCs block
    this.addLog(
      'RX',
      [0x04, ++this.blockCounter, 0x09, 0x88, 0x03],
      `Опрос кодов завершен. Всего ошибок: ${this.activeDtcs.length}`
    );

    this.dtcListeners.forEach((cb) => cb(this.activeDtcs));
    return this.activeDtcs;
  }

  public async clearFaultCodes(): Promise<boolean> {
    if (this.state !== 'CONNECTED') {
      throw new Error('Нет связи с ЭБУ.');
    }

    this.addLog(
      'TX',
      [0x03, ++this.blockCounter, 0x05, 0x03],
      'Команда стирания ошибок 0x05 (Clear Fault Codes)'
    );
    await this.delay(500);

    this.addLog(
      'RX',
      [0x03, ++this.blockCounter, 0x09, 0x03],
      'Память неисправностей ЭБУ успешно очищена (ACK 0x09)'
    );

    // Clear all except 00515 if engine is stopped
    if (!this.engineState.isEngineRunning) {
      this.activeDtcs = [
        {
          ...MONO_MOTRONIC_DTCS['00515'],
          status: 'active',
          statusText: 'Постоянная (двигатель заглушен)'
        }
      ];
      this.addLog(
        'INFO',
        [],
        'Код 00515 (Датчик Холла G40) остался в памяти, т.к. мотор не запущен. Это штатное поведение Mono-Motronic!'
      );
    } else {
      this.activeDtcs = [];
    }

    this.dtcListeners.forEach((cb) => cb(this.activeDtcs));
    return true;
  }

  public addSimulatedFault(code: string) {
    if (MONO_MOTRONIC_DTCS[code]) {
      const exists = this.activeDtcs.find((d) => d.code === code);
      if (!exists) {
        this.activeDtcs.push({
          ...MONO_MOTRONIC_DTCS[code],
          status: 'active',
          statusText: 'Постоянная'
        });
        this.dtcListeners.forEach((cb) => cb(this.activeDtcs));
        this.addLog('INFO', [], `В ЭБУ симулировано появление неисправности: ${code} ${MONO_MOTRONIC_DTCS[code].component}`);
      }
    }
  }

  public toggleEngineRunning() {
    this.engineState.isEngineRunning = !this.engineState.isEngineRunning;
    if (this.engineState.isEngineRunning) {
      this.engineState.rpm = 840;
      this.engineState.batteryVoltage = 14.1;
      this.engineState.injectionTimeMs = 1.65;
      // 00515 disappears when engine starts!
      this.activeDtcs = this.activeDtcs.filter((d) => d.code !== '00515');
      this.addLog(
        'INFO',
        [],
        'Двигатель запущен: 840 об/мин, генератор 14.1 В. Ошибка 00515 (Датчик Холла) автоматически снята.'
      );
    } else {
      this.engineState.rpm = 0;
      this.engineState.batteryVoltage = 12.3;
      this.engineState.injectionTimeMs = 0;
      this.engineState.throttleAngle = 0;
      this.engineState.idleSwitchClosed = true;
      if (!this.activeDtcs.some((d) => d.code === '00515')) {
        this.activeDtcs.unshift({
          ...MONO_MOTRONIC_DTCS['00515'],
          status: 'active',
          statusText: 'Постоянная (двигатель заглушен)'
        });
      }
      this.addLog('INFO', [], 'Двигатель заглушен (зажигание ВКЛ).');
    }
    this.broadcastEngine();
    this.dtcListeners.forEach((cb) => cb(this.activeDtcs));
  }

  public setThrottle(percent: number) {
    if (!this.engineState.isEngineRunning) {
      this.engineState.throttleAngle = Number((percent * 0.9).toFixed(1));
      this.engineState.idleSwitchClosed = percent <= 3;
    } else {
      this.engineState.throttleAngle = Number((percent * 0.9).toFixed(1));
      this.engineState.idleSwitchClosed = percent <= 3;
      this.engineState.rpm = Math.round(820 + (percent / 100) * 3800);
      this.engineState.injectionTimeMs = Number((1.5 + (percent / 100) * 3.8).toFixed(2));
      this.engineState.ignitionTimingDeg = Number((6.0 + (percent / 100) * 22).toFixed(1));
    }
    this.broadcastEngine();
  }

  public setCoolantTemp(degC: number) {
    this.engineState.coolantTemp = degC;
    this.broadcastEngine();
  }

  public setBasicSettingsMode(active: boolean) {
    this.engineState.basicSettingsActive = active;
    if (active) {
      // In basic settings for Mono-Motronic 1.2.3, timing is locked at 6 deg BTDC for strobe light check!
      this.engineState.ignitionTimingDeg = 6.0;
      this.addLog(
        'TX',
        [0x04, ++this.blockCounter, 0x28, 0x00, 0x03],
        'Вход в Базовые установки 0x28 (Группа 000). УОЗ заблокирован на 6.0° для стробоскопа!'
      );
    } else {
      this.addLog(
        'TX',
        [0x03, ++this.blockCounter, 0x06, 0x03],
        'Выход из режима базовых установок.'
      );
    }
    this.broadcastEngine();
  }

  public async runActuatorTest(actuatorId: string): Promise<void> {
    if (this.state !== 'CONNECTED') {
      throw new Error('Подключитесь к ЭБУ перед запуском теста исполнителей.');
    }
    this.addLog(
      'TX',
      [0x03, ++this.blockCounter, 0x04, 0x03],
      `Тест исполнителей: Активация ${actuatorId}`
    );
    await this.delay(1000);
    this.addLog(
      'RX',
      [0x05, ++this.blockCounter, 0xfa, 0x01, 0x03],
      `Исполнительный механизм [${actuatorId}] запущен в циклический тест.`
    );
  }

  // ==========================================
  // SIMULATION CLOCK & BROADCAST
  // ==========================================

  private startSimulationLoop() {
    this.simInterval = setInterval(() => {
      this.updatePhysics();
    }, 150);
  }

  private updatePhysics() {
    this.simAngle += 0.2;

    if (this.engineState.isEngineRunning) {
      // Warm up gradually
      if (this.engineState.coolantTemp < 89) {
        this.engineState.coolantTemp += 0.05;
      }

      // Lambda oscillates between 0.1 and 0.85V if warmed up
      if (this.engineState.coolantTemp > 60) {
        const sinVal = Math.sin(this.simAngle);
        this.engineState.lambdaVoltage = Number((0.48 + sinVal * 0.38 + (Math.random() * 0.04 - 0.02)).toFixed(3));
        this.engineState.lambdaFactor = Number((1.0 + sinVal * 0.04).toFixed(3));
      } else {
        // Cold enrichment
        this.engineState.lambdaVoltage = 0.75;
        this.engineState.lambdaFactor = 0.92;
      }

      // Small natural RPM jitter (±15 RPM)
      if (this.engineState.idleSwitchClosed) {
        const jitter = Math.round((Math.random() - 0.5) * 20);
        this.engineState.rpm = 820 + jitter;
        if (!this.engineState.basicSettingsActive) {
          this.engineState.ignitionTimingDeg = Number((6.0 + (Math.random() - 0.5) * 1.5).toFixed(1));
        }
      }
    } else {
      // Stopped
      this.engineState.lambdaVoltage = 0.45;
      this.engineState.lambdaFactor = 1.0;
    }

    if (this.state === 'CONNECTED') {
      this.broadcastEngine();
    }
  }

  private broadcastEngine() {
    const copy = { ...this.engineState };
    this.engineListeners.forEach((cb) => cb(copy));
    const groups = generateMeasuringGroups(copy);
    this.groupsListeners.forEach((cb) => cb(groups));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }
}

export const kw1281 = new Kw1281Engine();
