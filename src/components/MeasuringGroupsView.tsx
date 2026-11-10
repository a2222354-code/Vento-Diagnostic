/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Download,
  Info,
  Layers,
  Pause,
  Play,
  Table,
  Zap
} from 'lucide-react';
import { ConnectionState, MeasuringGroupData } from '../types/kw1281';

interface MeasuringGroupsViewProps {
  groups: MeasuringGroupData[];
  connectionState: ConnectionState;
}

export const MeasuringGroupsView: React.FC<MeasuringGroupsViewProps> = ({
  groups,
  connectionState
}) => {
  const [selectedGroupIdx, setSelectedGroupIdx] = useState<number>(0);
  const [isPaused, setIsPaused] = useState<boolean>(false);

  const activeGroup = groups[selectedGroupIdx] || groups[0];

  const handleExportCsv = () => {
    if (!activeGroup) return;
    const header = 'Канал,Название,Значение,Единица,Сырой байт (0-255),Норма Мин,Норма Макс,Описание\n';
    const rows = activeGroup.channels
      .map(
        (ch) =>
          `"${ch.channelNumber}","${ch.label}","${ch.value}","${ch.unit}","${ch.rawValue}","${ch.normalMin || ''}","${ch.normalMax || ''}","${ch.description}"`
      )
      .join('\n');
    const blob = new Blob(['\uFEFF' + header + rows], {
      type: 'text/csv;charset=utf-8;'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `VAG_Group_${String(activeGroup.groupNumber).padStart(3, '0')}_Log.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Top Selector & Action Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
        {/* Group Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-950 rounded-lg border border-slate-800 overflow-x-auto w-full sm:w-auto">
          {groups.map((grp, idx) => (
            <button
              key={grp.groupNumber}
              onClick={() => setSelectedGroupIdx(idx)}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap transition-all ${
                selectedGroupIdx === idx
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Группа {String(grp.groupNumber).padStart(3, '0')}
            </button>
          ))}
        </div>

        {/* Group Actions */}
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <button
            onClick={() => setIsPaused(!isPaused)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-colors ${
              isPaused
                ? 'bg-amber-950/60 border-amber-800 text-amber-300'
                : 'bg-slate-950 border-slate-800 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            <span>{isPaused ? 'Возобновить' : 'Пауза'}</span>
          </button>

          <button
            onClick={handleExportCsv}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-200 flex items-center gap-1.5 transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-blue-400" />
            <span>Экспорт в CSV</span>
          </button>
        </div>
      </div>

      {/* Active Group Header Details */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-400" />
              <span>{activeGroup.title}</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {activeGroup.description}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
            <span>Протокол: KW1281</span>
            <span aria-hidden="true">·</span>
            <span>Команда: 0x29 / 0x21</span>
          </div>
        </div>

        {/* Raw Bytes Ribbon (Crucial for Group 000 in Mono-Motronic!) */}
        {activeGroup.rawBytes && (
          <div className="mt-4 p-3 bg-slate-950 rounded-lg border border-slate-800">
            <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider mb-2 flex items-center justify-between">
              <span>Сырые байты ответа ЭБУ (Поля 1 — 10):</span>
              <span className="text-blue-400 font-mono">0 - 255 DEC</span>
            </div>
            <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5 text-center font-mono">
              {activeGroup.rawBytes.map((byteVal, i) => (
                <div
                  key={i}
                  className="bg-slate-900/90 border border-slate-800 p-2 rounded flex flex-col items-center"
                >
                  <span className="text-[10px] text-slate-500 mb-0.5">
                    #{i + 1}
                  </span>
                  <span className="text-sm sm:text-base font-bold text-blue-400">
                    {byteVal}
                  </span>
                  <span className="text-[9px] text-slate-600">
                    0x{byteVal.toString(16).padStart(2, '0').toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Channels Grid View */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
          {activeGroup.channels.map((ch) => {
            const hasNormal = ch.normalMin !== undefined && ch.normalMax !== undefined;
            const inTolerance =
              hasNormal && ch.value >= ch.normalMin! && ch.value <= ch.normalMax!;

            return (
              <div
                key={ch.channelNumber}
                className="bg-slate-950/60 border border-slate-800/90 rounded-lg p-3.5 flex flex-col justify-between"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      Поле {ch.channelNumber}
                    </div>
                    <div className="text-sm font-semibold text-slate-200 mt-0.5">
                      {ch.label}
                    </div>
                  </div>
                  {ch.statusBadge ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium">
                      {ch.statusBadge}
                    </span>
                  ) : hasNormal ? (
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded font-medium ${
                        inTolerance
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/50'
                          : 'bg-amber-950 text-amber-300 border border-amber-800/50'
                      }`}
                    >
                      {inTolerance ? 'В норме' : 'Отклонение'}
                    </span>
                  ) : null}
                </div>

                <div className="my-3 flex items-baseline gap-2">
                  <span className="text-2xl sm:text-3xl font-mono font-bold text-slate-100">
                    {ch.value}
                  </span>
                  {ch.unit && (
                    <span className="text-xs sm:text-sm font-mono text-slate-400">
                      {ch.unit}
                    </span>
                  )}
                  <span className="text-xs font-mono text-slate-500 ml-auto">
                    Сырое: {ch.rawValue}
                  </span>
                </div>

                <div className="border-t border-slate-900 pt-2 text-[11px] text-slate-400 flex flex-col gap-0.5">
                  <p>{ch.description}</p>
                  {hasNormal && (
                    <p className="text-slate-500 font-mono text-[10px]">
                      Заводская норма: {ch.normalMin} ... {ch.normalMax} {ch.unit}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Group 000 Reference Guide Modal / Card */}
      {selectedGroupIdx === 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Info className="w-4 h-4 text-blue-400" />
            <h3 className="text-xs sm:text-sm font-semibold text-slate-200">
              Справочник по полям Группы 000 (VW Vento Mono-Motronic 1.2.3)
            </h3>
          </div>
          <div className="overflow-x-auto text-xs">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 text-[11px]">
                  <th className="py-1.5 px-2">Поле</th>
                  <th className="py-1.5 px-2">Параметр</th>
                  <th className="py-1.5 px-2">Норма на прогретом ХХ (80°C+)</th>
                  <th className="py-1.5 px-2">Примечание</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300 font-mono text-[11px]">
                <tr>
                  <td className="py-1.5 px-2 text-blue-400">1</td>
                  <td className="py-1.5 px-2">Температура ОЖ</td>
                  <td className="py-1.5 px-2 text-emerald-400">170 - 205 (80-95°C)</td>
                  <td className="py-1.5 px-2 font-sans text-slate-400">Синий датчик G62</td>
                </tr>
                <tr>
                  <td className="py-1.5 px-2 text-blue-400">2</td>
                  <td className="py-1.5 px-2">Положение дросселя</td>
                  <td className="py-1.5 px-2 text-emerald-400">15 - 35 (0 - 5°)</td>
                  <td className="py-1.5 px-2 font-sans text-slate-400">Потенциометр ДПДЗ</td>
                </tr>
                <tr>
                  <td className="py-1.5 px-2 text-blue-400">3</td>
                  <td className="py-1.5 px-2">Обороты двигателя</td>
                  <td className="py-1.5 px-2 text-emerald-400">68 - 80 (750-850 об/мин)</td>
                  <td className="py-1.5 px-2 font-sans text-slate-400">Множитель × 25</td>
                </tr>
                <tr>
                  <td className="py-1.5 px-2 text-blue-400">4</td>
                  <td className="py-1.5 px-2">Коррекция смеси</td>
                  <td className="py-1.5 px-2 text-emerald-400">115 - 140 (128 = 1.0)</td>
                  <td className="py-1.5 px-2 font-sans text-slate-400">Меньше 115 = богатит, больше 140 = беднит/подсос</td>
                </tr>
                <tr>
                  <td className="py-1.5 px-2 text-blue-400">5</td>
                  <td className="py-1.5 px-2">Сигнал лямбда-зонда</td>
                  <td className="py-1.5 px-2 text-emerald-400">Пульсирует 25 - 230</td>
                  <td className="py-1.5 px-2 font-sans text-slate-400">Должно постоянно меняться вокруг 128</td>
                </tr>
                <tr>
                  <td className="py-1.5 px-2 text-blue-400">6</td>
                  <td className="py-1.5 px-2">Угол зажигания (УОЗ)</td>
                  <td className="py-1.5 px-2 text-emerald-400">12 - 20 (в Базовых: 15 = 6°)</td>
                  <td className="py-1.5 px-2 font-sans text-slate-400">Для стробоскопа в Базовых блокируется на 6°</td>
                </tr>
                <tr>
                  <td className="py-1.5 px-2 text-blue-400">8</td>
                  <td className="py-1.5 px-2">Напряжение питания</td>
                  <td className="py-1.5 px-2 text-emerald-400">165 - 195 (13.5 - 14.5 В)</td>
                  <td className="py-1.5 px-2 font-sans text-slate-400">Клемма 30 / Генератор</td>
                </tr>
                <tr>
                  <td className="py-1.5 px-2 text-blue-400">9</td>
                  <td className="py-1.5 px-2">Концевик РХХ</td>
                  <td className="py-1.5 px-2 text-emerald-400">32 (ХХ замкнут)</td>
                  <td className="py-1.5 px-2 font-sans text-slate-400">128 при нажатии на газ</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
