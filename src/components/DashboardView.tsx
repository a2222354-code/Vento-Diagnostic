/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  CheckCircle2,
  Gauge,
  Play,
  RotateCcw,
  Sliders,
  Square,
  Thermometer,
  Zap
} from 'lucide-react';
import { ConnectionState, EngineLiveState } from '../types/kw1281';
import { kw1281 } from '../services/kw1281Engine';

interface DashboardViewProps {
  engine: EngineLiveState;
  connectionState: ConnectionState;
  onNavigateTab: (tab: string) => void;
  faultCount: number;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  engine,
  connectionState,
  onNavigateTab,
  faultCount
}) => {
  const [history, setHistory] = useState<
    Array<{ rpm: number; lambda: number; throttle: number; timestamp: number }>
  >([]);

  useEffect(() => {
    const id = setInterval(() => {
      setHistory((prev) => {
        const next = [
          ...prev,
          {
            rpm: engine.rpm,
            lambda: engine.lambdaVoltage,
            throttle: engine.throttleAngle,
            timestamp: Date.now()
          }
        ];
        if (next.length > 50) next.shift();
        return next;
      });
    }, 250);
    return () => clearInterval(id);
  }, [engine]);

  const isConnected = connectionState === 'CONNECTED';

  // Calculations for gauges
  const rpmPercent = Math.min(100, (engine.rpm / 6000) * 100);
  const tempPercent = Math.min(
    100,
    Math.max(0, ((engine.coolantTemp - 40) / (120 - 40)) * 100)
  );
  const lambdaPercent = Math.min(100, Math.max(0, engine.lambdaVoltage * 100));

  return (
    <div className="space-y-4">
      {/* ECU Status Notice if disconnected */}
      {!isConnected && (
        <div className="bg-amber-950/40 border border-amber-800/60 rounded-xl p-3.5 flex items-center justify-between text-xs text-amber-200">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              Связь с блоком не установлена. Нажмите{' '}
              <strong className="text-white">«Установить связь»</strong> вверху для
              чтения параметров. Вы также можете тестировать симулятор ниже.
            </span>
          </div>
          <button
            onClick={() => kw1281.connect()}
            className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium shrink-0 ml-2"
          >
            Подключить
          </button>
        </div>
      )}

      {/* Main Gauges Section */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* RPM Tachometer */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Gauge className="w-4 h-4 text-blue-400" />
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">
                Тахометр (Обороты)
              </span>
            </div>
            <span className="text-xs text-slate-500 font-mono">1.8 ADZ 8V</span>
          </div>

          <div className="my-4 text-center">
            <div className="text-4xl sm:text-5xl font-mono font-bold text-slate-50 tracking-tight">
              {engine.rpm}
            </div>
            <div className="text-xs text-slate-400 mt-1">об / мин</div>
          </div>

          {/* Linear Meter */}
          <div>
            <div className="flex justify-between text-[10px] text-slate-500 font-mono mb-1">
              <span>0</span>
              <span>1000</span>
              <span>3000</span>
              <span>5000</span>
              <span className="text-rose-400">6000</span>
            </div>
            <div className="h-2.5 bg-slate-950 rounded-full overflow-hidden p-0.5 border border-slate-800 flex">
              <div
                className={`h-full rounded-full transition-all duration-150 ${
                  engine.rpm > 5500
                    ? 'bg-rose-500 shadow-[0_0_8px_#f43f5e]'
                    : engine.rpm > 4000
                    ? 'bg-amber-400'
                    : 'bg-blue-500'
                }`}
                style={{ width: `${rpmPercent}%` }}
              />
            </div>
          </div>
        </div>

        {/* Coolant Temperature */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Thermometer className="w-4 h-4 text-cyan-400" />
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">
                Температура ОЖ (ДТОЖ G62)
              </span>
            </div>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded ${
                engine.coolantTemp >= 80 && engine.coolantTemp <= 98
                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/60'
                  : engine.coolantTemp > 100
                  ? 'bg-rose-950 text-rose-300 border border-rose-800/60'
                  : 'bg-blue-950 text-blue-300 border border-blue-800/60'
              }`}
            >
              {engine.coolantTemp >= 80 && engine.coolantTemp <= 98
                ? 'Рабочая'
                : engine.coolantTemp > 100
                ? 'Перегрев'
                : 'Прогрев'}
            </span>
          </div>

          <div className="my-4 text-center">
            <div className="text-4xl sm:text-5xl font-mono font-bold text-slate-50">
              {Math.round(engine.coolantTemp)}°C
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Датчик на тройнике ГБЦ
            </div>
          </div>

          <div>
            <div className="flex justify-between text-[10px] text-slate-500 font-mono mb-1">
              <span className="text-blue-400">40°</span>
              <span className="text-emerald-400">80° - 95°C</span>
              <span className="text-rose-400">120°</span>
            </div>
            <div className="h-2.5 bg-slate-950 rounded-full overflow-hidden p-0.5 border border-slate-800">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  engine.coolantTemp > 100
                    ? 'bg-rose-500'
                    : engine.coolantTemp >= 80
                    ? 'bg-emerald-400'
                    : 'bg-cyan-500'
                }`}
                style={{ width: `${tempPercent}%` }}
              />
            </div>
          </div>
        </div>

        {/* Lambda Sensor G39 */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-purple-400" />
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">
                Лямбда-зонд (G39)
              </span>
            </div>
            <span className="text-xs text-slate-400 font-mono">
              λ ≈ {engine.lambdaFactor.toFixed(2)}
            </span>
          </div>

          <div className="my-4 text-center">
            <div className="text-4xl sm:text-5xl font-mono font-bold text-slate-50">
              {engine.lambdaVoltage.toFixed(3)}
              <span className="text-xl sm:text-2xl text-slate-400 ml-1">В</span>
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {engine.lambdaVoltage > 0.55
                ? 'Богатая смесь (сигнал высокий)'
                : engine.lambdaVoltage < 0.35
                ? 'Бедная смесь (сигнал низкий)'
                : 'Около стехиометрии (0.45В)'}
            </div>
          </div>

          <div>
            <div className="flex justify-between text-[10px] text-slate-500 font-mono mb-1">
              <span>0.1 В (Бедная)</span>
              <span>0.45 В</span>
              <span>0.9 В (Богатая)</span>
            </div>
            <div className="h-2.5 bg-slate-950 rounded-full overflow-hidden p-0.5 border border-slate-800">
              <div
                className="h-full rounded-full bg-purple-500 transition-all duration-100"
                style={{ width: `${lambdaPercent}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Grid of Key Numerical Parameters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {/* Battery */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <BatteryCharging className="w-3.5 h-3.5 text-emerald-400" />
            <span>Напряжение АКБ</span>
          </div>
          <div className="text-xl sm:text-2xl font-mono font-bold text-slate-100 mt-1">
            {engine.batteryVoltage.toFixed(1)} <span className="text-xs text-slate-400">В</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {engine.batteryVoltage >= 13.6 ? 'Генератор работает' : 'Напряжение АКБ'}
          </div>
        </div>

        {/* Throttle Angle */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <Sliders className="w-3.5 h-3.5 text-blue-400" />
            <span>Дроссель (ДПДЗ)</span>
          </div>
          <div className="text-xl sm:text-2xl font-mono font-bold text-slate-100 mt-1">
            {engine.throttleAngle.toFixed(1)}°
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Потенциометр моновпрыска
          </div>
        </div>

        {/* Idle Switch F60 */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <CheckCircle2
              className={`w-3.5 h-3.5 ${
                engine.idleSwitchClosed ? 'text-emerald-400' : 'text-slate-500'
              }`}
            />
            <span>Концевик ХХ (F60)</span>
          </div>
          <div className="text-xl sm:text-2xl font-mono font-bold mt-1">
            <span
              className={
                engine.idleSwitchClosed ? 'text-emerald-400' : 'text-amber-400'
              }
            >
              {engine.idleSwitchClosed ? 'ЗАМКНУТ' : 'ОТКРЫТ'}
            </span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {engine.idleSwitchClosed ? 'Педаль газа отпущена' : 'Нажата педаль'}
          </div>
        </div>

        {/* Ignition Timing */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span>УОЗ зажигания</span>
          </div>
          <div className="text-xl sm:text-2xl font-mono font-bold text-slate-100 mt-1">
            {engine.ignitionTimingDeg.toFixed(1)}°
            <span className="text-xs text-slate-400 ml-1">BTDC</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {engine.basicSettingsActive ? 'Фикс. 6° (Базовые)' : 'Опережение ЭБУ'}
          </div>
        </div>
      </div>

      {/* Interactive Engine Controls (Vehicle Sandbox) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-blue-400" />
            <h3 className="text-xs sm:text-sm font-semibold text-slate-200">
              Управление и проверка двигателя (Симулятор / Тест)
            </h3>
          </div>
          <span className="text-xs text-slate-400 hidden sm:inline">
            Для проверки алгоритмов до подключения к автомобилю
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
          {/* Ignition / Engine toggle */}
          <div>
            <label className="text-xs text-slate-400 block mb-1.5">
              Состояние двигателя:
            </label>
            <button
              onClick={() => kw1281.toggleEngineRunning()}
              className={`w-full py-2 px-3 rounded-lg font-medium text-xs flex items-center justify-center gap-2 transition-all ${
                engine.isEngineRunning
                  ? 'bg-rose-950/80 text-rose-300 border border-rose-800 hover:bg-rose-900'
                  : 'bg-emerald-950/80 text-emerald-300 border border-emerald-800 hover:bg-emerald-900'
              }`}
            >
              {engine.isEngineRunning ? (
                <>
                  <Square className="w-3.5 h-3.5" />
                  <span>Заглушить мотор</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>Завести мотор (840 об/мин)</span>
                </>
              )}
            </button>
            <p className="text-[11px] text-slate-500 mt-1">
              {engine.isEngineRunning
                ? 'Генератор 14.1В, ошибка 00515 отсутствует'
                : 'Заглушен: ошибка 00515 активна в памяти'}
            </p>
          </div>

          {/* Throttle Slider */}
          <div>
            <div className="flex justify-between text-xs text-slate-400 mb-1">
              <span>Педаль газа (Дроссель):</span>
              <span className="font-mono text-slate-200">
                {engine.throttleAngle.toFixed(1)}°
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={(engine.throttleAngle / 90) * 100}
              onChange={(e) => kw1281.setThrottle(Number(e.target.value))}
              className="w-full h-2 bg-slate-950 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-slate-500 mt-1">
              <span>ХХ (0°)</span>
              <span>Частичная</span>
              <span>Полный газ (90°)</span>
            </div>
          </div>

          {/* Coolant Slider */}
          <div>
            <div className="flex justify-between text-xs text-slate-400 mb-1">
              <span>Температура антифриза:</span>
              <span className="font-mono text-slate-200">
                {Math.round(engine.coolantTemp)}°C
              </span>
            </div>
            <input
              type="range"
              min="15"
              max="115"
              value={engine.coolantTemp}
              onChange={(e) => kw1281.setCoolantTemp(Number(e.target.value))}
              className="w-full h-2 bg-slate-950 rounded-lg appearance-none cursor-pointer accent-cyan-500"
            />
            <div className="flex justify-between text-[10px] text-slate-500 mt-1">
              <span>Холодный (15°C)</span>
              <span>Рабочая (90°C)</span>
              <span>Перегрев (115°C)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Realtime Waveform Telemetry Chart */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-purple-400" />
            <span className="text-xs font-semibold text-slate-200">
              Осциллограмма в реальном времени (Лямбда 0.1-0.9В & Обороты)
            </span>
          </div>
          <span className="text-[11px] text-slate-400">
            Частота опроса: 4 Гц
          </span>
        </div>

        <div className="h-32 w-full bg-slate-950 rounded-lg p-2 border border-slate-800/80 relative overflow-hidden flex items-end">
          {history.length > 1 ? (
            <svg className="w-full h-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 100">
              {/* Grid lines */}
              <line x1="0" y1="20" x2="100" y2="20" stroke="#1e293b" strokeWidth="0.5" strokeDasharray="2,2" />
              <line x1="0" y1="50" x2="100" y2="50" stroke="#1e293b" strokeWidth="0.5" strokeDasharray="2,2" />
              <line x1="0" y1="80" x2="100" y2="80" stroke="#1e293b" strokeWidth="0.5" strokeDasharray="2,2" />

              {/* RPM Polyline (normalized to 0-6000) */}
              <polyline
                fill="none"
                stroke="#38bdf8"
                strokeWidth="1.5"
                points={history
                  .map((pt, idx) => {
                    const x = (idx / (history.length - 1)) * 100;
                    const y = 100 - (pt.rpm / 6000) * 90;
                    return `${x},${y}`;
                  })
                  .join(' ')}
              />

              {/* Lambda Polyline (normalized to 0-1V) */}
              <polyline
                fill="none"
                stroke="#c084fc"
                strokeWidth="2"
                points={history
                  .map((pt, idx) => {
                    const x = (idx / (history.length - 1)) * 100;
                    const y = 100 - (pt.lambda / 1.0) * 80 - 10;
                    return `${x},${y}`;
                  })
                  .join(' ')}
              />
            </svg>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-slate-600">
              Сбор данных графика...
            </div>
          )}
        </div>
        <div className="flex items-center justify-between text-[11px] text-slate-500 mt-2 px-1">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-0.5 bg-blue-400 inline-block" />
              <span>Обороты (RPM)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-0.5 bg-purple-400 inline-block" />
              <span>Лямбда-зонд (В)</span>
            </div>
          </div>
          <span>Длина буфера: 50 замеров</span>
        </div>
      </div>

      {/* Quick Navigation Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button
          onClick={() => onNavigateTab('faults')}
          className="p-3 bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl text-left flex items-center justify-between group transition-colors"
        >
          <div>
            <div className="text-xs text-slate-400">Память неисправностей</div>
            <div className="text-sm font-semibold text-slate-200 mt-0.5">
              Ошибки ЭБУ (DTC)
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {faultCount > 0
                ? `Обнаружено: ${faultCount} неисправн.`
                : 'Ошибок в памяти нет'}
            </div>
          </div>
          <span className="text-xs font-mono text-blue-400 group-hover:translate-x-1 transition-transform">
            0x07 →
          </span>
        </button>

        <button
          onClick={() => onNavigateTab('groups')}
          className="p-3 bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl text-left flex items-center justify-between group transition-colors"
        >
          <div>
            <div className="text-xs text-slate-400">Группа 000 и другие</div>
            <div className="text-sm font-semibold text-slate-200 mt-0.5">
              Измерительные блоки
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              10 сырых параметров VAG
            </div>
          </div>
          <span className="text-xs font-mono text-blue-400 group-hover:translate-x-1 transition-transform">
            0x29 →
          </span>
        </button>

        <button
          onClick={() => onNavigateTab('actuators')}
          className="p-3 bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl text-left flex items-center justify-between group transition-colors"
        >
          <div>
            <div className="text-xs text-slate-400">Стробоскоп и РХХ</div>
            <div className="text-sm font-semibold text-slate-200 mt-0.5">
              Базовые установки
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Фиксация УОЗ на 6° для ADZ
            </div>
          </div>
          <span className="text-xs font-mono text-blue-400 group-hover:translate-x-1 transition-transform">
            0x28 →
          </span>
        </button>
      </div>
    </div>
  );
};
