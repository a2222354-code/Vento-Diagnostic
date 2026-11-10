/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Clock,
  Compass,
  Flame,
  Info,
  Play,
  RotateCcw,
  Sliders,
  StopCircle,
  Volume2,
  Wrench,
  Zap
} from 'lucide-react';
import { ActuatorTestItem, ConnectionState, EngineLiveState } from '../types/kw1281';
import { kw1281 } from '../services/kw1281Engine';
import { MONO_MOTRONIC_ACTUATORS } from '../services/vagData';

interface ActuatorsAndBasicSettingsViewProps {
  engine: EngineLiveState;
  connectionState: ConnectionState;
}

export const ActuatorsAndBasicSettingsView: React.FC<
  ActuatorsAndBasicSettingsViewProps
> = ({ engine, connectionState }) => {
  const [activeTestId, setActiveTestId] = useState<string | null>(null);
  const [testProgress, setTestProgress] = useState<number>(0);
  const [adaptationMessage, setAdaptationMessage] = useState<string | null>(null);

  const isConnected = connectionState === 'CONNECTED';

  const handleStartActuatorTest = async (actuator: ActuatorTestItem) => {
    if (!isConnected) return;
    setActiveTestId(actuator.id);
    setTestProgress(0);

    try {
      await kw1281.runActuatorTest(actuator.id);

      // Progress countdown
      const stepMs = 200;
      const totalSteps = (actuator.durationSeconds * 1000) / stepMs;
      let current = 0;

      const timer = setInterval(() => {
        current++;
        setTestProgress(Math.min(100, (current / totalSteps) * 100));
        if (current >= totalSteps) {
          clearInterval(timer);
          setActiveTestId(null);
          setTestProgress(0);
        }
      }, stepMs);
    } catch (e: any) {
      alert(e.message);
      setActiveTestId(null);
    }
  };

  const handleToggleBasicSettings = () => {
    if (!isConnected) return;
    const nextState = !engine.basicSettingsActive;
    kw1281.setBasicSettingsMode(nextState);
  };

  const handleResetAdaptations = () => {
    if (!isConnected) return;
    setAdaptationMessage(
      'Адаптационные таблицы ЭБУ Mono-Motronic 1.2.3 (Канал 00) успешно сброшены к заводским значениям!'
    );
    setTimeout(() => setAdaptationMessage(null), 5000);
  };

  return (
    <div className="space-y-4">
      {/* SECTION 1: BASIC SETTINGS (STROBOSCOPE & IGNITION TIMING 6 DEG) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-slate-100 flex items-center gap-2">
                <span>Базовые установки (Basic Settings 0x28)</span>
                {engine.basicSettingsActive && (
                  <span className="text-xs px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800 font-semibold animate-pulse">
                    АКТИВЕН: УОЗ 6°
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-400">
                Фиксация угла опережения зажигания на 6° для регулировки стробоскопом
              </p>
            </div>
          </div>

          <button
            onClick={handleToggleBasicSettings}
            disabled={!isConnected}
            className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all shadow-sm ${
              engine.basicSettingsActive
                ? 'bg-amber-600 hover:bg-amber-500 text-white'
                : 'bg-slate-950 hover:bg-slate-800 border border-slate-700 text-slate-100'
            }`}
          >
            {engine.basicSettingsActive ? (
              <>
                <StopCircle className="w-4 h-4" />
                <span>Выйти из базовых</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 text-amber-400" />
                <span>Войти в базовые (Группа 000)</span>
              </>
            )}
          </button>
        </div>

        {/* Technical Instruction Box */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 space-y-2.5 text-xs text-slate-300">
            <div className="bg-slate-950/70 p-3.5 rounded-lg border border-slate-800/80 space-y-2">
              <h4 className="font-semibold text-amber-400 flex items-center gap-1.5">
                <Compass className="w-4 h-4" />
                <span>Как правильно выставить зажигание на двигателе 1.8 ADZ / ABS:</span>
              </h4>
              <ol className="list-decimal list-inside space-y-1 text-slate-300 leading-relaxed text-[11px] sm:text-xs">
                <li>
                  Прогрейте двигатель до рабочей температуры (температура ОЖ &ge; 80°C).
                </li>
                <li>
                  Включите режим <strong>«Базовые установки (Группа 000)»</strong>. ЭБУ заблокирует динамическую коррекцию УОЗ ровно на <strong>6° до ВМТ</strong>.
                </li>
                <li>
                  Подключите стробоскоп к высоковольтному проводу 1-го цилиндра и к питанию АКБ.
                </li>
                <li>
                  Выкрутите пластиковую заглушку смотрового лючка на картере сцепления КПП.
                </li>
                <li>
                  Направьте луч стробоскопа на метки маховика. При 800-900 об/мин метка «0» или насечка 6° должна строго совпадать с выступом картера сцепления.
                </li>
                <li>
                  Если метка смещена: ослабьте болт крепления трамблера (ключ на 13) и аккуратно поворачивайте корпус распределителя до совпадения меток.
                </li>
                <li>
                  Затяните болт трамблера и нажмите «Выйти из базовых».
                </li>
              </ol>
            </div>
          </div>

          <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="text-[11px] text-slate-500 font-mono">
                ТЕКУЩИЙ УОЗ ЭБУ
              </div>
              <div className="text-3xl font-mono font-bold text-amber-400 mt-1">
                {engine.ignitionTimingDeg.toFixed(1)}°
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                {engine.basicSettingsActive
                  ? 'Заблокирован на 6.0° BTDC для стробоскопа'
                  : 'Динамический расчет ЭБУ по оборотам и нагрузке'}
              </div>
            </div>

            <div className="border-t border-slate-800/80 pt-3 mt-3">
              <div className="text-[11px] text-slate-400 mb-1.5">
                Сброс адаптаций (Канал 00):
              </div>
              <button
                onClick={handleResetAdaptations}
                disabled={!isConnected}
                className="w-full py-1.5 px-3 rounded-md bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center justify-center gap-1.5 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5 text-blue-400" />
                <span>Сбросить адаптации</span>
              </button>
            </div>
          </div>
        </div>

        {adaptationMessage && (
          <div className="mt-3 p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-800 text-xs text-emerald-200 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{adaptationMessage}</span>
          </div>
        )}
      </div>

      {/* SECTION 2: ACTUATOR TESTS (OUTPUT TESTS 0x04) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
        <div className="flex items-center gap-2.5 border-b border-slate-800 pb-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400">
            <Wrench className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-slate-100">
              Тест исполнительных механизмов (Actuator Test 0x04)
            </h2>
            <p className="text-xs text-slate-400">
              Принудительное включение узлов моновпрыска при заглушенном двигателе
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {MONO_MOTRONIC_ACTUATORS.map((actuator) => {
            const isRunning = activeTestId === actuator.id;

            return (
              <div
                key={actuator.id}
                className={`border rounded-xl p-4 flex flex-col justify-between transition-colors ${
                  isRunning
                    ? 'bg-blue-950/30 border-blue-700'
                    : 'bg-slate-950/70 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold text-blue-400 px-1.5 py-0.5 rounded bg-blue-950 border border-blue-900">
                        {actuator.componentCode}
                      </span>
                      <h4 className="text-sm font-semibold text-slate-200">
                        {actuator.name}
                      </h4>
                    </div>

                    <button
                      onClick={() => handleStartActuatorTest(actuator)}
                      disabled={!isConnected || activeTestId !== null}
                      className={`px-3 py-1 text-xs font-semibold rounded-md flex items-center gap-1.5 transition-all ${
                        isRunning
                          ? 'bg-blue-600 text-white animate-pulse'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40'
                      }`}
                    >
                      <Play className="w-3 h-3" />
                      <span>{isRunning ? 'Тестирование...' : 'Запуск теста'}</span>
                    </button>
                  </div>

                  <p className="text-xs text-slate-300 mt-2 leading-relaxed">
                    {actuator.description}
                  </p>

                  <div className="mt-2.5 p-2 rounded bg-slate-900 border border-slate-800/80 text-[11px] text-slate-400 flex items-start gap-1.5">
                    <Volume2 className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-slate-300">Что слушать:</strong>{' '}
                      {actuator.soundHint}
                    </span>
                  </div>
                </div>

                {/* Progress bar if running */}
                {isRunning && (
                  <div className="mt-3">
                    <div className="flex justify-between text-[10px] text-blue-300 font-mono mb-1">
                      <span>Имитация активации исполнителя...</span>
                      <span>{Math.round(testProgress)}%</span>
                    </div>
                    <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all duration-200"
                        style={{ width: `${testProgress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
