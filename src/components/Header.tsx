/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  Cpu,
  ExternalLink,
  Flame,
  QrCode,
  Radio,
  Share2,
  Smartphone,
  Unplug,
  Usb,
  X
} from 'lucide-react';
import { ConnectionState, OperatingMode } from '../types/kw1281';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface HeaderProps {
  connectionState: ConnectionState;
  mode: OperatingMode;
  onModeChange: (mode: OperatingMode) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  ecuPartNumber: string;
}

export const Header: React.FC<HeaderProps> = ({
  connectionState,
  mode,
  onModeChange,
  onConnect,
  onDisconnect,
  ecuPartNumber
}) => {
  const { isInstallable, install } = usePWAInstall();
  const [showShareModal, setShowShareModal] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const isConnected = connectionState === 'CONNECTED';
  const isBusy =
    connectionState === 'SEARCHING_USB' ||
    connectionState === 'USB_CONNECTED' ||
    connectionState === 'INIT_5BAUD' ||
    connectionState === 'SYNC_RECEIVED' ||
    connectionState === 'READING_TITLE';

  // The active web app link
  const webAppUrl =
    typeof window !== 'undefined' && window.location.origin.includes('http')
      ? window.location.origin
      : 'https://ais-pre-szoz64ibjsjnmfeo6c3sk6-348342340765.europe-west2.run.app';

  const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
    webAppUrl
  )}&bgcolor=090D16&color=38BDF8&margin=10`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(webAppUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const getStateText = () => {
    switch (connectionState) {
      case 'CONNECTED':
        return 'Связь установлена (9600 бод)';
      case 'INIT_5BAUD':
        return '5-бод инициализация...';
      case 'SYNC_RECEIVED':
        return 'Синхронизация 0x55';
      case 'READING_TITLE':
        return 'Чтение данных ЭБУ...';
      case 'SEARCHING_USB':
        return 'Поиск адаптера FT232...';
      case 'USB_CONNECTED':
        return 'USB порт открыт';
      case 'ERROR':
        return 'Ошибка подключения';
      default:
        return 'Отключено';
    }
  };

  const getStateDotColor = () => {
    switch (connectionState) {
      case 'CONNECTED':
        return 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]';
      case 'ERROR':
        return 'bg-rose-500';
      case 'DISCONNECTED':
        return 'bg-slate-500';
      default:
        return 'bg-amber-400 animate-pulse';
    }
  };

  return (
    <>
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-40 px-3 sm:px-6 py-2.5">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
          {/* Brand & Vehicle Context */}
          <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
            <div className="flex items-center gap-2.5">
              <img
                src="/vento_icon.png"
                alt="VW Vento"
                className="w-10 h-10 rounded-lg border border-slate-700/80 object-cover shadow-sm bg-slate-950"
              />
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-sm sm:text-base font-bold text-slate-100 tracking-tight">
                    Vento Diagnostic
                  </h1>
                  <span className="text-xs text-blue-400 font-mono font-medium">
                    v1.2.3
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span>VW Vento 1995 1.8 ADZ</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{ecuPartNumber}</span>
                </div>
              </div>
            </div>

            {/* Mobile Actions: Share & Quick Connect */}
            <div className="flex md:hidden items-center gap-2">
              <button
                onClick={() => setShowShareModal(true)}
                className="p-1.5 rounded-md bg-slate-800 text-blue-400 border border-slate-700"
                title="Ссылка и QR-код"
              >
                <QrCode className="w-4 h-4" />
              </button>

              {isConnected ? (
                <button
                  onClick={onDisconnect}
                  className="px-2.5 py-1 text-xs font-medium rounded-md bg-rose-950/80 text-rose-300 border border-rose-800 hover:bg-rose-900 flex items-center gap-1.5"
                >
                  <Unplug className="w-3.5 h-3.5" />
                  <span>Отключить</span>
                </button>
              ) : (
                <button
                  onClick={onConnect}
                  disabled={isBusy}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 flex items-center gap-1.5 shadow-sm"
                >
                  <Radio className="w-3.5 h-3.5" />
                  <span>{isBusy ? 'Связь...' : 'Подключить'}</span>
                </button>
              )}
            </div>
          </div>

          {/* Operating Mode Selector & Hardware Status */}
          <div className="flex items-center flex-wrap gap-2 sm:gap-3 w-full md:w-auto justify-between md:justify-end">
            {/* Hardware Source Toggle */}
            <div className="inline-flex rounded-lg bg-slate-950 p-0.5 border border-slate-800 text-xs">
              <button
                onClick={() => onModeChange('SIMULATOR')}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1.5 ${
                  mode === 'SIMULATOR'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Cpu className="w-3.5 h-3.5" />
                <span>Эмулятор 3A0 907 311</span>
              </button>
              <button
                onClick={() => onModeChange('USB_KKL')}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1.5 ${
                  mode === 'USB_KKL'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Usb className="w-3.5 h-3.5" />
                <span>KKL FT232 (OTG)</span>
              </button>
            </div>

            {/* Connection Status indicator */}
            <div className="flex items-center gap-2 px-2.5 py-1 rounded-md bg-slate-950/70 border border-slate-800/80 text-xs">
              <span className={`w-2 h-2 rounded-full ${getStateDotColor()}`} />
              <span className="text-slate-300 font-medium">{getStateText()}</span>
            </div>

            {/* Share / Open on Phone Button */}
            <button
              onClick={() => setShowShareModal(true)}
              className="px-2.5 py-1 text-xs font-medium rounded-md bg-slate-950 hover:bg-slate-800 text-blue-400 border border-slate-800 flex items-center gap-1.5 transition-colors"
              title="Открыть на телефоне через QR-код"
            >
              <QrCode className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Ссылка на Web</span>
            </button>

            {/* Install PWA Button on Android / Chrome */}
            {isInstallable && (
              <button
                onClick={install}
                className="px-2.5 py-1 text-xs font-medium rounded-md bg-emerald-700/80 text-emerald-100 hover:bg-emerald-600 border border-emerald-600/50 flex items-center gap-1.5 transition-colors"
                title="Установить на домашний экран Android"
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span>На телефон</span>
              </button>
            )}

            {/* Desktop Connect / Disconnect Button */}
            <div className="hidden md:flex items-center gap-2">
              {isConnected ? (
                <button
                  onClick={onDisconnect}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-rose-950/80 text-rose-300 border border-rose-800 hover:bg-rose-900 flex items-center gap-1.5 transition-colors"
                >
                  <Unplug className="w-3.5 h-3.5" />
                  <span>Разорвать связь</span>
                </button>
              ) : (
                <button
                  onClick={onConnect}
                  disabled={isBusy}
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 flex items-center gap-1.5 shadow-sm transition-all"
                >
                  <Radio className="w-3.5 h-3.5" />
                  <span>{isBusy ? 'Подключение...' : 'Установить связь'}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Share / Open on Phone Modal */}
      {showShareModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl relative">
            <button
              onClick={() => setShowShareModal(false)}
              className="absolute top-4 right-4 p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="text-center">
              <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 mx-auto mb-2">
                <Smartphone className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-slate-100">
                Ссылка на Web-версию
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Отсканируйте камерой телефона (Ulefone Armor 21) или скопируйте ссылку:
              </p>
            </div>

            {/* QR Code Container */}
            <div className="my-4 p-3 bg-slate-950 rounded-xl border border-slate-800 flex flex-col items-center justify-center">
              <img
                src={qrApiUrl}
                alt="QR-код для открытия на телефоне"
                className="w-48 h-48 rounded-lg shadow-md"
                loading="eager"
              />
              <span className="text-[11px] text-slate-500 mt-2 font-mono">
                Наведите камеру смартфона
              </span>
            </div>

            {/* Direct URL Box */}
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between gap-2">
              <div className="truncate text-xs font-mono text-blue-400">
                {webAppUrl}
              </div>
              <button
                onClick={handleCopyLink}
                className="px-2.5 py-1 text-xs font-semibold rounded bg-blue-600 hover:bg-blue-500 text-white shrink-0 flex items-center gap-1 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Скопировано!' : 'Копировать'}</span>
              </button>
            </div>

            <div className="mt-4 text-[11px] text-slate-400 space-y-1">
              <p>💡 <strong>Как подключить KKL адаптер:</strong></p>
              <p>
                1. Откройте эту ссылку в <strong>Google Chrome</strong> на телефоне.
              </p>
              <p>
                2. Подключите адаптер KKL FT232 через OTG-переходник.
              </p>
              <p>
                3. Нажмите кнопку <strong>«Подключить»</strong> и подтвердите доступ к USB в Chrome!
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
