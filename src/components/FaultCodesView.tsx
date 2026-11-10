/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Copy,
  Info,
  PlusCircle,
  RefreshCw,
  Trash2,
  Wrench
} from 'lucide-react';
import { ConnectionState, DtcFault } from '../types/kw1281';
import { kw1281 } from '../services/kw1281Engine';
import { MONO_MOTRONIC_DTCS } from '../services/vagData';

interface FaultCodesViewProps {
  dtcs: DtcFault[];
  connectionState: ConnectionState;
}

export const FaultCodesView: React.FC<FaultCodesViewProps> = ({
  dtcs,
  connectionState
}) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [showClearConfirm, setShowClearConfirm] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [selectedDtcToInject, setSelectedDtcToInject] = useState<string>('00522');

  const isConnected = connectionState === 'CONNECTED';

  const handleReadFaults = async () => {
    setIsLoading(true);
    try {
      await kw1281.readFaultCodes();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearFaults = async () => {
    setIsLoading(true);
    try {
      await kw1281.clearFaultCodes();
      setShowClearConfirm(false);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyReport = () => {
    const text = [
      '==========================================',
      'ОТЧЕТ ДИАГНОСТИКИ ОШИБОК VAG KW1281',
      `Автомобиль: VW Vento 1995 (1.8 ADZ)`,
      `ЭБУ: ${kw1281.ecuInfo.partNumber} (${kw1281.ecuInfo.component})`,
      `Дата: ${new Date().toLocaleString('ru-RU')}`,
      `Всего ошибок: ${dtcs.length}`,
      '==========================================\n',
      ...dtcs.map(
        (d, idx) =>
          `[${idx + 1}] DTC ${d.code} (${d.hexCode}) — ${d.component}\n` +
          `Статус: ${d.statusText}\n` +
          `Описание: ${d.description}\n` +
          `Причина: ${d.cause}\n` +
          `Рекомендация: ${d.remedy}\n`
      )
    ].join('\n');

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* Control Action Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400">
            <AlertCircle className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-slate-100 flex items-center gap-2">
              <span>Память неисправностей (DTC)</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                {dtcs.length} {dtcs.length === 1 ? 'ошибка' : dtcs.length >= 2 && dtcs.length <= 4 ? 'ошибки' : 'ошибок'}
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Чтение и стирание кодов по протоколу KW1281 (Команды 0x07 и 0x05)
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <button
            onClick={handleCopyReport}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-200 flex items-center gap-1.5 transition-colors"
          >
            <Copy className="w-3.5 h-3.5 text-blue-400" />
            <span>{copied ? 'Скопировано!' : 'Копировать отчёт'}</span>
          </button>

          <button
            onClick={() => setShowClearConfirm(true)}
            disabled={!isConnected || isLoading || dtcs.length === 0}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-950/80 hover:bg-rose-900 border border-rose-800 text-rose-200 disabled:opacity-40 flex items-center gap-1.5 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Стереть ошибки</span>
          </button>

          <button
            onClick={handleReadFaults}
            disabled={!isConnected || isLoading}
            className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 flex items-center gap-1.5 shadow-sm transition-all"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>{isLoading ? 'Опрос...' : 'Опросить ЭБУ'}</span>
          </button>
        </div>
      </div>

      {/* Confirmation Modal for Clearing Faults */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-rose-950 border border-rose-800 flex items-center justify-center text-rose-400 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">
                  Стереть память неисправностей?
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  ЭБУ выполнит очистку кодов ошибок (команда KW1281 0x05). Если
                  двигатель выключен, ошибка 00515 (датчик Холла) вернётся снова,
                  что является нормальным для Mono-Motronic 1.2.3.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Отмена
              </button>
              <button
                onClick={handleClearFaults}
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-sm"
              >
                Да, стереть ошибки
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DTC List */}
      {dtcs.length > 0 ? (
        <div className="space-y-3">
          {dtcs.map((dtc) => (
            <div
              key={dtc.code}
              className={`border rounded-xl p-4 transition-colors ${
                dtc.isExpectedWhenStopped
                  ? 'bg-slate-900/90 border-blue-800/60'
                  : 'bg-slate-900 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/70 pb-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-lg font-mono font-bold text-blue-400 tracking-wider">
                    {dtc.code}
                  </span>
                  <span className="text-xs font-mono text-slate-500">
                    [0x{dtc.hexCode}]
                  </span>
                  <span className="text-sm font-semibold text-slate-100">
                    {dtc.component}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-medium ${
                      dtc.status === 'active'
                        ? 'bg-rose-950 text-rose-300 border border-rose-800/60'
                        : 'bg-amber-950 text-amber-300 border border-amber-800/60'
                    }`}
                  >
                    {dtc.statusText}
                  </span>
                </div>
              </div>

              {/* Sub-description */}
              <div className="mt-2.5">
                <div className="text-xs font-medium text-slate-200">
                  {dtc.description}
                </div>

                {dtc.isExpectedWhenStopped && (
                  <div className="mt-2 p-2.5 rounded-lg bg-blue-950/40 border border-blue-800/50 flex items-start gap-2 text-xs text-blue-200">
                    <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                    <span>
                      <strong>Особенность Mono-Motronic 1.2.3:</strong> При
                      выключенном моторе (зажигание ВКЛ) ЭБУ не получает импульсов
                      от трамблера и считает это ошибкой 00515. Как только мотор
                      заведется, ошибка исчезает. Если ошибка висит на заведенном
                      моторе — тогда требуется ремонт трамблера.
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 text-xs">
                  <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 font-medium block mb-1">
                      Возможная причина:
                    </span>
                    <span className="text-slate-300 leading-relaxed">
                      {dtc.cause}
                    </span>
                  </div>

                  <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-emerald-400 font-medium block mb-1 flex items-center gap-1">
                      <Wrench className="w-3.5 h-3.5" />
                      <span>Что проверить и как устранить:</span>
                    </span>
                    <span className="text-slate-300 leading-relaxed">
                      {dtc.remedy}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-emerald-950/80 border border-emerald-800 flex items-center justify-center text-emerald-400 mx-auto mb-3">
            <CheckCircle className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-slate-100">
            Ошибок в памяти ЭБУ не обнаружено
          </h3>
          <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
            Блок управления 3A0 907 311 не зафиксировал сбоев в работе датчиков и
            исполнительных механизмов.
          </p>
        </div>
      )}

      {/* Simulator: Fault Injection Panel */}
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <PlusCircle className="w-4 h-4 text-blue-400" />
          <h3 className="text-xs sm:text-sm font-semibold text-slate-200">
            Симулятор: Имитация неисправности датчика
          </h3>
        </div>
        <p className="text-xs text-slate-400 mb-3">
          Вы можете смоделировать появление реальной неисправности в ЭБУ, чтобы
          увидеть реакцию алгоритмов расшифровки:
        </p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <select
            value={selectedDtcToInject}
            onChange={(e) => setSelectedDtcToInject(e.target.value)}
            className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500 font-mono"
          >
            {Object.entries(MONO_MOTRONIC_DTCS).map(([code, item]) => (
              <option key={code} value={code}>
                DTC {code} — {item.component}
              </option>
            ))}
          </select>

          <button
            onClick={() => kw1281.addSimulatedFault(selectedDtcToInject)}
            className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors shrink-0"
          >
            Добавить неисправность в ЭБУ
          </button>
        </div>
      </div>
    </div>
  );
};
