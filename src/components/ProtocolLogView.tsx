/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle,
  Download,
  Filter,
  Info,
  Pause,
  Play,
  Search,
  Terminal,
  Trash2,
  XCircle
} from 'lucide-react';
import { ProtocolLogEntry } from '../types/kw1281';

interface ProtocolLogViewProps {
  logs: ProtocolLogEntry[];
  onClearLogs: () => void;
}

export const ProtocolLogView: React.FC<ProtocolLogViewProps> = ({
  logs,
  onClearLogs
}) => {
  const [filterType, setFilterType] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter((log) => {
    if (filterType !== 'ALL' && log.direction !== filterType) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchHex = log.hexString.toLowerCase().includes(q);
      const matchDesc = log.description.toLowerCase().includes(q);
      if (!matchHex && !matchDesc) return false;
    }
    return true;
  });

  const handleExportTxt = () => {
    const content = logs
      .map(
        (l) =>
          `[${l.timestamp}] [${l.direction}] ${l.hexString ? `[HEX: ${l.hexString}] ` : ''}${l.description}`
      )
      .join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `KW1281_Sniffer_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getDirectionBadge = (dir: ProtocolLogEntry['direction']) => {
    switch (dir) {
      case 'TX':
        return (
          <span className="flex items-center gap-1 text-blue-400 font-mono text-[11px]">
            <ArrowUpCircle className="w-3.5 h-3.5 text-blue-400" />
            <span>TX</span>
          </span>
        );
      case 'RX':
        return (
          <span className="flex items-center gap-1 text-emerald-400 font-mono text-[11px]">
            <ArrowDownCircle className="w-3.5 h-3.5 text-emerald-400" />
            <span>RX</span>
          </span>
        );
      case 'ERR':
        return (
          <span className="flex items-center gap-1 text-rose-400 font-mono text-[11px]">
            <XCircle className="w-3.5 h-3.5 text-rose-400" />
            <span>ERR</span>
          </span>
        );
      case 'SUCCESS':
        return (
          <span className="flex items-center gap-1 text-emerald-400 font-mono text-[11px]">
            <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
            <span>OK</span>
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1 text-slate-400 font-mono text-[11px]">
            <Info className="w-3.5 h-3.5 text-slate-400" />
            <span>LOG</span>
          </span>
        );
    }
  };

  return (
    <div className="space-y-4">
      {/* Search and Action Toolbar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
        {/* Filter buttons */}
        <div className="flex items-center gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800 text-xs w-full sm:w-auto overflow-x-auto">
          {['ALL', 'TX', 'RX', 'INFO', 'ERR'].map((type) => (
            <button
              key={type}
              onClick={() => setFilterType(type)}
              className={`px-2.5 py-1 rounded font-mono font-medium transition-colors ${
                filterType === type
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {type === 'ALL' ? 'Все' : type}
            </button>
          ))}
        </div>

        {/* Search Bar & Actions */}
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <div className="relative flex-1 sm:w-48">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Поиск по HEX или тексту..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1.5 rounded-lg border text-xs ${
              autoScroll
                ? 'bg-blue-950 text-blue-300 border-blue-800'
                : 'bg-slate-950 text-slate-400 border-slate-800'
            }`}
            title={autoScroll ? 'Автопрокрутка включена' : 'Автопрокрутка на паузе'}
          >
            {autoScroll ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={handleExportTxt}
            className="p-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-300"
            title="Экспорт в .txt"
          >
            <Download className="w-3.5 h-3.5 text-blue-400" />
          </button>

          <button
            onClick={onClearLogs}
            className="p-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-800 text-rose-400"
            title="Очистить журнал"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal View */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden font-mono shadow-inner">
        {/* Terminal Header */}
        <div className="bg-slate-900/90 px-4 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-blue-400" />
            <span className="font-semibold text-slate-200">
              KW1281 Raw Packet Sniffer (K-Line / UART 9600)
            </span>
          </div>
          <div>
            Записей: <strong className="text-slate-200">{filteredLogs.length}</strong>
          </div>
        </div>

        {/* Scrollable logs area */}
        <div
          ref={logContainerRef}
          className="h-[480px] overflow-y-auto p-3 space-y-1.5 text-xs text-slate-300"
        >
          {filteredLogs.length > 0 ? (
            filteredLogs.map((log) => (
              <div
                key={log.id}
                className="py-1 px-2 rounded hover:bg-slate-900/60 flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 transition-colors border-l-2 border-transparent hover:border-blue-500"
              >
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] text-slate-500">
                    {log.timestamp}
                  </span>
                  <span className="w-12">{getDirectionBadge(log.direction)}</span>
                </div>

                {log.hexString && (
                  <div className="shrink-0 text-amber-300/90 font-bold tracking-wider text-[11px] bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800/80">
                    {log.hexString}
                  </div>
                )}

                <div className="text-slate-300 text-[11px] break-words">
                  {log.description}
                </div>
              </div>
            ))
          ) : (
            <div className="h-full flex items-center justify-center text-slate-600 text-xs">
              Журнал обмена пуст или записи не соответствуют фильтру.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
