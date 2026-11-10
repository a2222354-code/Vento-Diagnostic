/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Code,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileCode,
  FolderGit2,
  Github,
  HelpCircle,
  Play,
  Rocket,
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
  const [activeSubTab, setActiveSubTab] = useState<'guide' | 'code'>('guide');
  const [selectedFileIdx, setSelectedFileIdx] = useState<number>(0);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [copiedCommands, setCopiedCommands] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);

  const currentFile = ANDROID_PROJECT_FILES[selectedFileIdx] || ANDROID_PROJECT_FILES[0];

  const handleDownloadZip = async () => {
    setIsDownloading(true);
    try {
      const blob = await createAndroidProjectZip();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'VAG_KW1281_Android_Project_GitHub.zip';
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
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const gitPushScript = `# 1. Распакуйте скачанный zip-архив и перейдите в папку
cd VAG_KW1281_Android_Project_GitHub

# 2. Инициализируйте репозиторий git
git init
git add .
git commit -m "Initial commit for KW1281 Android Diag"

# 3. Подключите ваш созданный репозиторий на GitHub
git branch -M main
git remote add origin https://github.com/ВАШ_ЛОГИН/kw1281-vento-android.git

# 4. Отправьте код — GitHub Actions соберёт APK автоматически!
git push -u origin main`;

  const handleCopyGitCommands = () => {
    navigator.clipboard.writeText(gitPushScript);
    setCopiedCommands(true);
    setTimeout(() => setCopiedCommands(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400 shrink-0">
            <Github className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <span>Сборка APK в облаке GitHub Actions</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800 font-mono">
                Без Android Studio
              </span>
            </h2>
            <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed">
              Вам не нужно устанавливать тяжёлую Android Studio (5+ ГБ) на свой
              компьютер: виртуальный сервер GitHub сам скомпилирует готовый
              установочный <strong>.apk</strong> за ~1.5 минуты и выдаст ссылку на
              скачивание!
            </p>
          </div>
        </div>

        <button
          onClick={handleDownloadZip}
          disabled={isDownloading}
          className="w-full md:w-auto px-4 py-2.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center gap-2 shadow-sm transition-all shrink-0"
        >
          <Download className="w-4 h-4" />
          <span>{isDownloading ? 'Формирование архива...' : 'Скачать готовый ZIP для GitHub'}</span>
        </button>
      </div>

      {/* Sub-Tabs: Guide vs Code Inspector */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveSubTab('guide')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
            activeSubTab === 'guide'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          <Rocket className="w-3.5 h-3.5" />
          <span>Пошаговая инструкция сборки на GitHub</span>
        </button>

        <button
          onClick={() => setActiveSubTab('code')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
            activeSubTab === 'code'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          <Code className="w-3.5 h-3.5" />
          <span>Файлы проекта и воркфлоу Actions ({ANDROID_PROJECT_FILES.length})</span>
        </button>
      </div>

      {/* VIEW 1: STEP-BY-STEP GITHUB ACTIONS GUIDE */}
      {activeSubTab === 'guide' && (
        <div className="space-y-4">
          {/* Step Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Step 1 */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono font-bold text-blue-400 px-2 py-0.5 rounded bg-blue-950 border border-blue-900">
                    ШАГ 1
                  </span>
                  <FolderGit2 className="w-4 h-4 text-slate-500" />
                </div>
                <h4 className="text-sm font-semibold text-slate-100">
                  Создайте новый репозиторий на GitHub
                </h4>
                <ol className="list-decimal list-inside text-xs text-slate-300 mt-2 space-y-1 leading-relaxed">
                  <li>Зайдите на сайт <strong>github.com</strong> и войдите в свой аккаунт.</li>
                  <li>Нажмите зелёную кнопку <strong>«New»</strong> (Создать репозиторий).</li>
                  <li>В поле <em>Repository name</em> укажите, например, <code>kw1281-vento-android</code>.</li>
                  <li>Оставьте тип <strong>Public</strong> (или Private) и нажмите <strong>«Create repository»</strong>.</li>
                </ol>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-800/80 text-[11px] text-slate-400">
                Репозиторий готов к приёму файлов проекта.
              </div>
            </div>

            {/* Step 2 */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono font-bold text-blue-400 px-2 py-0.5 rounded bg-blue-950 border border-blue-900">
                    ШАГ 2
                  </span>
                  <Download className="w-4 h-4 text-slate-500" />
                </div>
                <h4 className="text-sm font-semibold text-slate-100">
                  Загрузите файлы проекта (с папкой .github)
                </h4>
                <div className="text-xs text-slate-300 mt-2 space-y-2 leading-relaxed">
                  <p>
                    <strong>Вариант А (через браузер):</strong> Распакуйте скачанный ZIP, нажмите на GitHub кнопку <strong>«Upload files»</strong>, перетащите все файлы и нажмите <em>Commit changes</em>.
                  </p>
                  <p>
                    <strong>Вариант Б (через консоль Git):</strong> выполните 4 быстрые команды (скопируйте блок ниже).
                  </p>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-800/80 text-[11px] text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>Архив уже содержит готовый файл .github/workflows/build-apk.yml!</span>
              </div>
            </div>

            {/* Step 3 */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono font-bold text-blue-400 px-2 py-0.5 rounded bg-blue-950 border border-blue-900">
                    ШАГ 3
                  </span>
                  <Play className="w-4 h-4 text-slate-500" />
                </div>
                <h4 className="text-sm font-semibold text-slate-100">
                  Автоматическая сборка в разделе «Actions»
                </h4>
                <ol className="list-decimal list-inside text-xs text-slate-300 mt-2 space-y-1 leading-relaxed">
                  <li>Откройте вкладку <strong>«Actions»</strong> вверху вашего репозитория.</li>
                  <li>Вы увидите воркфлоу <strong>«Build Android APK (KW1281 Diag)»</strong>.</li>
                  <li>Он запускается сам при каждом <code>git push</code>.</li>
                  <li>Также можно нажать <em>Run workflow</em> для ручного запуска в любой момент.</li>
                </ol>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-800/80 text-[11px] text-slate-400">
                Время сборки: ~90-120 секунд на сервере Ubuntu с JDK 17.
              </div>
            </div>

            {/* Step 4 */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono font-bold text-emerald-400 px-2 py-0.5 rounded bg-emerald-950 border border-emerald-900">
                    ШАГ 4 — ГОТОВО!
                  </span>
                  <Smartphone className="w-4 h-4 text-emerald-400" />
                </div>
                <h4 className="text-sm font-semibold text-slate-100">
                  Скачивание APK прямо на телефон
                </h4>
                <ol className="list-decimal list-inside text-xs text-slate-300 mt-2 space-y-1 leading-relaxed">
                  <li>Когда сборка завершится зелёной галочкой ✅, кликните на неё.</li>
                  <li>Прокрутите страницу в самый низ до блока <strong>«Artifacts»</strong>.</li>
                  <li>Нажмите на <strong>kw1281-vento-debug-apk</strong>.</li>
                  <li>Скачается ZIP-архив с файлом <strong>app-debug.apk</strong>.</li>
                  <li>Откройте его на телефоне (Ulefone Armor 21) и нажмите «Установить»!</li>
                </ol>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-800/80 text-[11px] text-blue-300">
                Готовое нативное приложение с USB OTG и 5-бод драйвером установлено на телефон!
              </div>
            </div>
          </div>

          {/* Quick Git Terminal Commands Snippet */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-blue-400" />
                <h4 className="text-xs sm:text-sm font-semibold text-slate-200">
                  Команды для отправки проекта на GitHub через терминал:
                </h4>
              </div>
              <button
                onClick={handleCopyGitCommands}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs flex items-center gap-1.5 transition-colors"
              >
                {copiedCommands ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedCommands ? 'Скопировано!' : 'Копировать команды'}</span>
              </button>
            </div>
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80 font-mono text-xs text-blue-300 overflow-x-auto leading-relaxed">
              <pre>{gitPushScript}</pre>
            </div>
          </div>

          {/* Explanation of the GitHub Actions Workflow */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs text-slate-300 space-y-2">
            <h4 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Code className="w-4 h-4 text-purple-400" />
              <span>Что делает файл .github/workflows/build-apk.yml:</span>
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
              <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                <strong className="text-slate-100 block mb-1">1. Виртуальная машина</strong>
                <p className="text-slate-400 text-[11px]">
                  Запускает чистый контейнер Ubuntu Linux с установленным Android SDK и Java 17.
                </p>
              </div>
              <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                <strong className="text-slate-100 block mb-1">2. Компиляция Gradle</strong>
                <p className="text-slate-400 text-[11px]">
                  Выполняет команду <code>./gradlew assembleDebug</code>, собирая Kotlin код и драйвер FTDI.
                </p>
              </div>
              <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                <strong className="text-slate-100 block mb-1">3. Публикация APK</strong>
                <p className="text-slate-400 text-[11px]">
                  Загружает скомпилированный <code>app-debug.apk</code> в защищённое хранилище GitHub Artifacts.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 2: CODE & FILES INSPECTOR */}
      {activeSubTab === 'code' && (
        <div className="space-y-4">
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
                {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedCode ? 'Скопировано!' : 'Копировать'}</span>
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
      )}
    </div>
  );
};
