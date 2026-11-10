/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Code,
  Copy,
  Cpu,
  Download,
  FileCode,
  HelpCircle,
  Smartphone,
  Terminal,
  Usb
} from 'lucide-react';
import {
  ANDROID_PROJECT_FILES,
  AndroidProjectFile,
  createAndroidProjectZip
} from '../services/androidProjectGenerator';

export const AndroidProjectView: React.FC = () => {
  const [selectedFileIdx, setSelectedFileIdx] = useState<number>(0);
  const [copied, setCopied] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);

  const currentFile = ANDROID_PROJECT_FILES[selectedFileIdx] || ANDROID_PROJECT_FILES[0];

  const handleDownloadZip = async () => {
    setIsDownloading(true);
    try {
      const blob = await createAndroidProjectZip();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'VAG_KW1281_Android_Studio_Project.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Ошибка создания архива: ${e.message}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(currentFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* Overview & Quick Download Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0">
            <Smartphone className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <span>Android Studio Проект (Нативный Kotlin / Jetpack Compose)</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800 font-mono">
                APK Готов
              </span>
            </h2>
            <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed">
              Полный исходный код мобильного приложения для Android (10–14) с
              поддержкой USB-OTG, драйвера FTDI FT232 и решением проблемы 5 бод
              через аппаратный Break/BitBang.
            </p>
          </div>
        </div>

        <button
          onClick={handleDownloadZip}
          disabled={isDownloading}
          className="w-full md:w-auto px-4 py-2.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center gap-2 shadow-sm transition-all shrink-0"
        >
          <Download className="w-4 h-4" />
          <span>{isDownloading ? 'Сборка ZIP архива...' : 'Скачать проект Android Studio (.zip)'}</span>
        </button>
      </div>

      {/* Hardware Connection Architecture Guide */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <h3 className="text-xs sm:text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2">
          <Usb className="w-4 h-4 text-blue-400" />
          <span>Схема аппаратного подключения: Телефон &rarr; Адаптер &rarr; VW Vento</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-center text-xs">
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 flex flex-col items-center justify-center">
            <Smartphone className="w-5 h-5 text-blue-400 mb-1" />
            <span className="font-semibold text-slate-200">Ulefone / Android 13</span>
            <span className="text-[11px] text-slate-400 mt-0.5">Включить USB OTG</span>
          </div>

          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 flex flex-col items-center justify-center">
            <Cpu className="w-5 h-5 text-cyan-400 mb-1" />
            <span className="font-semibold text-slate-200">OTG Переходник</span>
            <span className="text-[11px] text-slate-400 mt-0.5">Type-C на USB-A Мама</span>
          </div>

          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 flex flex-col items-center justify-center">
            <Usb className="w-5 h-5 text-emerald-400 mb-1" />
            <span className="font-semibold text-slate-200">KKL USB (FT232RL)</span>
            <span className="text-[11px] text-slate-400 mt-0.5">VID 0x0403, PID 0x6001</span>
          </div>

          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 flex flex-col items-center justify-center">
            <Code className="w-5 h-5 text-amber-400 mb-1" />
            <span className="font-semibold text-slate-200">VW Vento 2x2 / OBD</span>
            <span className="text-[11px] text-slate-400 mt-0.5">K-Line &rarr; ЭБУ 3A0 907 311</span>
          </div>
        </div>

        {/* 5 Baud Solution Technical Callout */}
        <div className="mt-3 p-3 rounded-lg bg-blue-950/40 border border-blue-800/60 text-xs text-blue-200 flex items-start gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <strong>Как решена проблема 5 бод в драйвере Ftdi5BaudDriver.kt:</strong>
            <p className="text-slate-300 leading-relaxed text-[11px]">
              В чипах FTDI минимальная стандартная скорость составляет 183 бода.
              Для формирования 5-бодового импульса (200 мс на бит) используется
              прямое управление линией через команду <code>setBreak(true)</code> /{' '}
              <code>setBreak(false)</code> с точными паузами 200 мс. Это формирует
              идеальный адрес 0x01 (Start bit 200ms, 7 data bits LSB, odd parity,
              stop bit), после чего порт переключается на 9600 бод для приема 0x55!
            </p>
          </div>
        </div>
      </div>

      {/* Code Browser */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        {/* File Tabs */}
        <div className="bg-slate-950 p-2 border-b border-slate-800 flex items-center justify-between gap-2 overflow-x-auto">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {ANDROID_PROJECT_FILES.map((file, idx) => (
              <button
                key={file.path}
                onClick={() => setSelectedFileIdx(idx)}
                className={`px-3 py-1.5 rounded-md text-xs font-mono whitespace-nowrap flex items-center gap-1.5 transition-all ${
                  selectedFileIdx === idx
                    ? 'bg-blue-600 text-white shadow-sm font-semibold'
                    : 'text-slate-400 hover:text-slate-200 bg-slate-900/60 border border-slate-800/70'
                }`}
              >
                <FileCode className="w-3.5 h-3.5" />
                <span>{file.filename}</span>
              </button>
            ))}
          </div>

          <button
            onClick={handleCopyCode}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs flex items-center gap-1.5 shrink-0 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Скопировано!' : 'Копировать'}</span>
          </button>
        </div>

        {/* File Path & Description Bar */}
        <div className="px-4 py-2 bg-slate-900/90 border-b border-slate-800/80 flex items-center justify-between text-xs">
          <span className="font-mono text-blue-400">{currentFile.path}</span>
          <span className="text-slate-400 text-[11px] hidden sm:inline">
            {currentFile.description}
          </span>
        </div>

        {/* Code Content */}
        <div className="p-4 bg-slate-950 overflow-x-auto text-xs font-mono text-slate-300 max-h-[500px] overflow-y-auto leading-relaxed">
          <pre>
            <code>{currentFile.content}</code>
          </pre>
        </div>
      </div>
    </div>
  );
};
