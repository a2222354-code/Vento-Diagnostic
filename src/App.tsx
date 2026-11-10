/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Cpu,
  FileCode,
  Gauge,
  Layers,
  Sliders,
  Terminal,
  WifiOff
} from 'lucide-react';
import { Header } from './components/Header';
import { DashboardView } from './components/DashboardView';
import { MeasuringGroupsView } from './components/MeasuringGroupsView';
import { FaultCodesView } from './components/FaultCodesView';
import { ActuatorsAndBasicSettingsView } from './components/ActuatorsAndBasicSettingsView';
import { ProtocolLogView } from './components/ProtocolLogView';
import { AndroidProjectView } from './components/AndroidProjectView';
import {
  ConnectionState,
  DtcFault,
  EngineLiveState,
  MeasuringGroupData,
  OperatingMode,
  ProtocolLogEntry
} from './types/kw1281';
import { kw1281 } from './services/kw1281Engine';
import { generateMeasuringGroups } from './services/vagData';

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [connectionState, setConnectionState] = useState<ConnectionState>(kw1281.getState());
  const [mode, setMode] = useState<OperatingMode>(kw1281.getMode());
  const [engineState, setEngineState] = useState<EngineLiveState>(kw1281.getEngineState());
  const [measuringGroups, setMeasuringGroups] = useState<MeasuringGroupData[]>(
    generateMeasuringGroups(kw1281.getEngineState())
  );
  const [dtcs, setDtcs] = useState<DtcFault[]>(kw1281.getActiveDtcs());
  const [logs, setLogs] = useState<ProtocolLogEntry[]>([]);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const unsubState = kw1281.onState((s) => setConnectionState(s));
    const unsubEngine = kw1281.onEngine((e) => setEngineState(e));
    const unsubGroups = kw1281.onGroups((g) => setMeasuringGroups(g));
    const unsubDtcs = kw1281.onDtcs((d) => setDtcs(d));
    const unsubLog = kw1281.onLog((entry) => {
      setLogs((prev) => [...prev.slice(-300), entry]);
    });

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial simulated auto-connect for smooth onboarding
    kw1281.connect();

    return () => {
      unsubState();
      unsubEngine();
      unsubGroups();
      unsubDtcs();
      unsubLog();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleModeChange = (newMode: OperatingMode) => {
    setMode(newMode);
    kw1281.setMode(newMode);
  };

  const tabs = [
    { id: 'dashboard', label: 'Приборная панель', icon: Gauge },
    { id: 'groups', label: 'Группы (000)', icon: Layers },
    {
      id: 'faults',
      label: 'Ошибки ЭБУ',
      icon: AlertCircle,
      badge: dtcs.length > 0 ? String(dtcs.length) : undefined
    },
    { id: 'actuators', label: 'Базовые / Тесты', icon: Sliders },
    { id: 'logs', label: 'Журнал KW1281', icon: Terminal },
    { id: 'android', label: 'Android Studio Проект', icon: FileCode }
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-600 selection:text-white">
      {/* Top Header */}
      <Header
        connectionState={connectionState}
        mode={mode}
        onModeChange={handleModeChange}
        onConnect={() => kw1281.connect()}
        onDisconnect={() => kw1281.disconnect()}
        ecuPartNumber={kw1281.ecuInfo.partNumber}
      />

      {/* ECU Identification Bar */}
      <div className="bg-slate-900/60 border-b border-slate-800/80 px-3 sm:px-6 py-2 text-xs">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2 text-slate-400">
          <div className="flex flex-wrap items-center gap-2 sm:gap-4 font-mono text-[11px] sm:text-xs">
            <span className="text-slate-300 font-semibold">
              ЭБУ: {kw1281.ecuInfo.partNumber}
            </span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span>{kw1281.ecuInfo.component}</span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span>Код: {kw1281.ecuInfo.coding}</span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span>{kw1281.ecuInfo.dealerCode}</span>
          </div>

          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-slate-500 font-medium">Протокол:</span>
            <span className="text-blue-400 font-mono font-semibold">KW1281</span>
            <span className="text-slate-600">|</span>
            <span className="text-slate-400 font-mono">5 Baud Init &rarr; 9600 bps</span>
          </div>
        </div>
      </div>

      {/* Navigation Tabs (Mobile & Desktop) */}
      <nav className="border-b border-slate-800 bg-slate-900/40 px-3 sm:px-6 sticky top-[57px] sm:top-[61px] z-30 backdrop-blur">
        <div className="max-w-7xl mx-auto flex items-center gap-1 overflow-x-auto py-1.5 scrollbar-none">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2 whitespace-nowrap transition-colors relative ${
                  isActive
                    ? 'bg-blue-600 text-white shadow-sm font-semibold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
                {tab.badge && (
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold font-mono ${
                      isActive
                        ? 'bg-white text-blue-600'
                        : 'bg-rose-500 text-white'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Main View Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-3 sm:p-6 pb-12">
        {activeTab === 'dashboard' && (
          <DashboardView
            engine={engineState}
            connectionState={connectionState}
            onNavigateTab={setActiveTab}
            faultCount={dtcs.length}
          />
        )}

        {activeTab === 'groups' && (
          <MeasuringGroupsView
            groups={measuringGroups}
            connectionState={connectionState}
          />
        )}

        {activeTab === 'faults' && (
          <FaultCodesView
            dtcs={dtcs}
            connectionState={connectionState}
          />
        )}

        {activeTab === 'actuators' && (
          <ActuatorsAndBasicSettingsView
            engine={engineState}
            connectionState={connectionState}
          />
        )}

        {activeTab === 'logs' && (
          <ProtocolLogView
            logs={logs}
            onClearLogs={() => setLogs([])}
          />
        )}

        {activeTab === 'android' && <AndroidProjectView />}
      </main>

      {/* Offline Alert Indicator if disconnected from Internet */}
      {!isOnline && (
        <div className="fixed bottom-3 left-3 z-50 flex items-center gap-2 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 shadow-lg">
          <WifiOff className="w-3.5 h-3.5 animate-pulse" />
          <span>Автономный режим (PWA сохранено в памяти телефона)</span>
        </div>
      )}
    </div>
  );
}
