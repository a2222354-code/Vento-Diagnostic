/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DtcFault, EcuIdentification, MeasuringGroupData, ActuatorTestItem } from '../types/kw1281';

export const DEFAULT_ECU_VENTO: EcuIdentification = {
  partNumber: '3A0 907 311',
  component: '1.8l R4 MONO 1.2.3 D30',
  coding: '00000',
  dealerCode: 'WSC 01317',
  system: 'Bosch Mono-Motronic 1.2.3',
  engineCode: 'ADZ (66 kW / 90 л.с., 1.8L)',
  baudRate: 9600
};

export const MONO_MOTRONIC_DTCS: Record<string, Omit<DtcFault, 'status' | 'statusText'>> = {
  '00515': {
    code: '00515',
    hexCode: '0203',
    component: 'Датчик Холла (G40)',
    description: '03-00 — Нет сигнала / Обрыв цепи',
    cause: 'Двигатель заглушен (зажигание ВКЛ) ЛИБО неисправен датчик Холла в трамблере, обрыв проводки, срезаны зубья ремня ГРМ.',
    remedy: 'ВАЖНО ДЛЯ MONO-MOTRONIC: При незаведённом моторе эта ошибка ВСЕГДА присутствует в памяти блоков 1.2.3! Это норма. Если ошибка остается при РАБОТАЮЩЕМ моторе — проверить разъем трамблера (пины 1-3 питание 11-12В, пин 2 сигнальный импульс светодиодным тестером).',
    isExpectedWhenStopped: true
  },
  '00525': {
    code: '00525',
    hexCode: '020D',
    component: 'Лямбда-зонд (G39)',
    description: '03-10 — Сигнал вне допустимого диапазона / Нет сигнала',
    cause: 'Неисправность датчика кислорода, обрыв сигнального провода, отсутствие подогрева датчика (предохранитель №18), сильный подсос воздуха.',
    remedy: 'Проверить опорное напряжение на разъеме зонда (~0.45В при отключенном разъеме), проверить подогрев (~3-5 Ом между белыми проводами, +12В при запущенном моторе). Оценить колебания напряжения в группе 001 (должно скакать 0.1–0.9 В).'
  },
  '00516': {
    code: '00516',
    hexCode: '0204',
    component: 'Концевой выключатель ХХ (F60)',
    description: '27-00 — Недостоверный сигнал / Обрыв или замыкание',
    cause: 'Заедание тросика газа, не отрегулирован зазор штока регулятора холостого хода (РХХ VDO), загрязнение или окисление контактов концевика на штоке РХХ.',
    remedy: 'Проверить замыкание концевика при отпущенной педали газа (пины 1 и 2 на 4/6-контактном разъеме РХХ). Зазор между упором дросселя и штоком должен быть 0.5 мм при втянутом штоке.'
  },
  '00522': {
    code: '00522',
    hexCode: '020A',
    component: 'Датчик температуры ОЖ (G62)',
    description: '30-00 — Обрыв цепи или замыкание на плюс',
    cause: 'Неисправен синий датчик температуры (на тройнике ГБЦ), окисление 2-х или 4-х контактного разъема, обрыв проводки к ЭБУ.',
    remedy: 'Замерить сопротивление ДТОЖ мультиметром: при 20°C должно быть ~2000–3000 Ом, при 90°C (прогретый) ~200–300 Ом. При обрыве ЭБУ считает температуру -40°C и заливает свечи.'
  },
  '00523': {
    code: '00523',
    hexCode: '020B',
    component: 'Датчик температуры впускного воздуха (G42)',
    description: '30-00 — Обрыв или короткое замыкание',
    cause: 'Обрыв в крышке форсунки моновпрыска (ДТВВ встроен над форсункой), повреждение 4-контактного разъема форсунки.',
    remedy: 'Замерить сопротивление между крайними пинами 1 и 4 на разъеме форсунки (должно быть аналогично ДТОЖ, ~2500 Ом при 20°C).'
  },
  '00561': {
    code: '00561',
    hexCode: '0231',
    component: 'Адаптация смеси (Mixture Regulation)',
    description: '08-00 — Достигнут предел регулирования (обогащение/обеднение)',
    cause: 'Порвана резино-металлическая подушка моновпрыска (подсос воздуха), трещины вакуумного шланга к вакуумному усилителю тормозов, забит топливный фильтр, низкое давление насоса (< 0.8 бар).',
    remedy: 'Покачать моновпрыск рукой на заведенном двигателе — если обороты меняются, подушка порвана. Проверить давление топлива в рампе (норма 0.8–1.2 бар для Mono-Motronic). Сбросить адаптации (Канал 00 в Базовых).'
  },
  '00670': {
    code: '00670',
    hexCode: '029E',
    component: 'Датчик положения регулятора дросселя (G88)',
    description: '27-00 — Недостоверный сигнал',
    cause: 'Износ дорожек потенциометра внутри электропривода РХХ (сервопривода холостого хода VDO), механическое заклинивание моторчика.',
    remedy: 'Выполнить тест исполнителей РХХ, проверить плавность изменения сопротивления потенциометра при выдвижении штока.'
  },
  '00281': {
    code: '00281',
    hexCode: '0119',
    component: 'Датчик скорости автомобиля (G68)',
    description: '03-00 — Нет сигнала',
    cause: 'Обрыв проводки от датчика скорости на КПП (3-контактный датчик Холла) к панели приборов или ЭБУ двигателя.',
    remedy: 'Проверить питание на разъеме датчика скорости (+12В и масса), вращение тросика/шестерни в приводе спидометра.'
  },
  '00532': {
    code: '00532',
    hexCode: '0214',
    component: 'Напряжение бортовой сети (клемма 30)',
    description: '07-00 — Сигнал слишком мал / велик',
    cause: 'Просадка АКБ при пуске (< 10В), неисправность регулятора генератора (> 15В), окисление силовых клемм или шины массы на кузов/КПП.',
    remedy: 'Замерить напряжение на клеммах АКБ и на контактах ЭБУ под нагрузкой. Проверить надежность "косички" массы от кузова к двигателю.'
  },
  '01249': {
    code: '01249',
    hexCode: '04E1',
    component: 'Форсунка впрыска топлива (N30)',
    description: '31-00 — Обрыв или короткое замыкание на массу',
    cause: 'Обрыв обмотки форсунки, повреждение проводки на моновпрыске, плохой контакт в разъеме.',
    remedy: 'Сопротивление низкоомной форсунки Mono-Motronic составляет 1.2–1.6 Ом. Проверить сопротивление и балластный резистор в проводке.'
  },
  '01247': {
    code: '01247',
    hexCode: '04DF',
    component: 'Электромагнитный клапан 1 адсорбера (N80)',
    description: '31-00 — Обрыв или короткое замыкание',
    cause: 'Клапан продувки угольного фильтра (на правом брызговике/корпусе возд. фильтра) обесточен или заклинил.',
    remedy: 'Сопротивление катушки клапана N80 должно быть ~40–50 Ом. Проверить щелкание клапана через тест исполнителей.'
  },
  '65535': {
    code: '65535',
    hexCode: 'FFFF',
    component: 'Блок управления двигателем (ЭБУ)',
    description: '00-00 — Внутренняя ошибка контрольной суммы памяти',
    cause: 'Сбой микросхемы EEPROM/ПЗУ, попадание влаги в ЭБУ (часто заливает через дренаж под лобовым стеклом на Golf 3 / Vento).',
    remedy: 'Осмотреть плату ЭБУ 3A0 907 311 на предмет коррозии, окислов и трещин пайки разъема.'
  }
};

export const MONO_MOTRONIC_ACTUATORS: ActuatorTestItem[] = [
  {
    id: 'idle_stepper',
    name: 'Регулятор холостого хода (РХХ / V60)',
    componentCode: 'V60',
    description: 'Электропривод РХХ выдвигает и задвигает шток, приоткрывая дроссельную заслонку.',
    durationSeconds: 15,
    soundHint: 'Слышно жужжание моторчика в моновпрыске и видно движение рычага заслонки',
    instructions: 'Включите зажигание (двигатель заглушен). Наблюдайте за штоком РХХ под капотом.'
  },
  {
    id: 'evap_valve',
    name: 'Клапан продувки адсорбера (N80)',
    componentCode: 'N80',
    description: 'Электромагнитный клапан вентиляции бака открывается и закрывается с частотой ~2 Гц.',
    durationSeconds: 15,
    soundHint: 'Ритмичное громкое щелкание клапана возле корпуса воздушного фильтра',
    instructions: 'Положите палец на клапан N80 — должны ощущаться четкие щелчки.'
  },
  {
    id: 'injector',
    name: 'Форсунка моновпрыска (N30)',
    componentCode: 'N30',
    description: 'Имитация импульсов открывания форсунки моновпрыска.',
    durationSeconds: 10,
    soundHint: 'Характерное сухое щелкание форсунки в центре моновпрыска',
    instructions: 'Двигатель должен быть выключен. Проверьте четкость срабатывания иглы.'
  },
  {
    id: 'fuel_pump',
    name: 'Реле топливного насоса (J17 / №167)',
    componentCode: 'J17',
    description: 'ЭБУ подает массу на катушку реле №167 в блоке предохранителей.',
    durationSeconds: 10,
    soundHint: 'Щелчок реле в блоке предохранителей и кратковременное гудение бензонасоса в баке',
    instructions: 'Послушайте бензонасос под ковриком багажника.'
  }
];

export function generateMeasuringGroups(engine: {
  rpm: number;
  coolantTemp: number;
  throttleAngle: number;
  lambdaVoltage: number;
  lambdaFactor: number;
  injectionTimeMs: number;
  intakeTemp: number;
  batteryVoltage: number;
  ignitionTimingDeg: number;
  idleSwitchClosed: boolean;
}): MeasuringGroupData[] {
  // Convert physical values into Mono-Motronic raw 0-255 bytes:
  // Coolant temp formula in 1.2.3: byte roughly corresponds to inverted/non-linear lookup.
  // 90C ~ 185, 20C ~ 70
  const coolantRaw = Math.min(255, Math.max(0, Math.round(engine.coolantTemp * 1.8 + 25)));
  const throttleRaw = Math.min(255, Math.max(0, Math.round((engine.throttleAngle / 90) * 255)));
  const rpmRaw = Math.min(255, Math.max(0, Math.round(engine.rpm / 25)));
  const lambdaRaw = Math.min(255, Math.max(0, Math.round(engine.lambdaFactor * 128)));
  const batteryRaw = Math.min(255, Math.max(0, Math.round((engine.batteryVoltage / 16) * 210)));

  return [
    {
      groupNumber: 0,
      title: 'Группа 000 — Сырые параметры Mono-Motronic',
      description: '10 базовых байтов состояния ЭБУ 3A0 907 311 (по заводской документации VAG)',
      rawBytes: [
        coolantRaw,
        throttleRaw,
        rpmRaw,
        lambdaRaw,
        Math.round((engine.lambdaVoltage / 1.0) * 255),
        Math.round(engine.ignitionTimingDeg * 2.5),
        Math.round(engine.intakeTemp * 1.5 + 40),
        batteryRaw,
        engine.idleSwitchClosed ? 32 : 128,
        engine.rpm > 500 ? 1 : 0
      ],
      channels: [
        {
          channelNumber: 1,
          label: 'Температура ОЖ (1)',
          value: engine.coolantTemp,
          unit: '°C',
          rawValue: coolantRaw,
          min: -40,
          max: 125,
          normalMin: 80,
          normalMax: 98,
          description: 'Показания синего ДТОЖ G62 (норма на прогретом: 170-205)',
          statusBadge: engine.coolantTemp >= 80 && engine.coolantTemp <= 98 ? 'В норме' : 'Вне нормы'
        },
        {
          channelNumber: 2,
          label: 'Дроссель ДПДЗ (2)',
          value: engine.throttleAngle,
          unit: '°',
          rawValue: throttleRaw,
          min: 0,
          max: 90,
          normalMin: 0,
          normalMax: 5,
          description: 'Угол заслонки на ХХ: 0-5° (байт 15-35)',
          statusBadge: engine.throttleAngle <= 5 ? 'ХХ' : 'Нагрузка'
        },
        {
          channelNumber: 3,
          label: 'Обороты мотора (3)',
          value: engine.rpm,
          unit: 'об/мин',
          rawValue: rpmRaw,
          min: 0,
          max: 6500,
          normalMin: 750,
          normalMax: 900,
          description: 'Холостой ход ADZ 1.8: 750–850 об/мин (байт 68-80)'
        },
        {
          channelNumber: 4,
          label: 'Фактор смеси (4)',
          value: engine.lambdaFactor,
          unit: 'λ',
          rawValue: lambdaRaw,
          min: 0.7,
          max: 1.3,
          normalMin: 0.95,
          normalMax: 1.05,
          description: 'Адаптация топливоподачи (байт 128 = стехиометрия 1.00)'
        },
        {
          channelNumber: 5,
          label: 'Лямбда сигнал (5)',
          value: engine.lambdaVoltage,
          unit: 'В',
          rawValue: Math.round((engine.lambdaVoltage / 1.0) * 255),
          min: 0.0,
          max: 1.0,
          normalMin: 0.1,
          normalMax: 0.9,
          description: 'Напряжение на черном проводе G39 (должно пульсировать)'
        },
        {
          channelNumber: 6,
          label: 'УОЗ зажигания (6)',
          value: engine.ignitionTimingDeg,
          unit: '° BTDC',
          rawValue: Math.round(engine.ignitionTimingDeg * 2.5),
          min: -5,
          max: 45,
          normalMin: 5,
          normalMax: 8,
          description: 'Угол опережения зажигания (6° ±1° в базовых установках)'
        },
        {
          channelNumber: 7,
          label: 'Температура впуска (7)',
          value: engine.intakeTemp,
          unit: '°C',
          rawValue: Math.round(engine.intakeTemp * 1.5 + 40),
          min: -20,
          max: 70,
          normalMin: 15,
          normalMax: 50,
          description: 'Датчик температуры воздуха в моновпрыске G42'
        },
        {
          channelNumber: 8,
          label: 'Напряжение АКБ (8)',
          value: engine.batteryVoltage,
          unit: 'В',
          rawValue: batteryRaw,
          min: 9,
          max: 16,
          normalMin: 13.5,
          normalMax: 14.5,
          description: 'Бортовое напряжение генератора/АКБ (норма 13.8–14.4 В)'
        },
        {
          channelNumber: 9,
          label: 'Концевик ХХ F60 (9)',
          value: engine.idleSwitchClosed ? 1 : 0,
          unit: '',
          rawValue: engine.idleSwitchClosed ? 32 : 128,
          min: 0,
          max: 1,
          description: 'Состояние контакта штока РХХ (замкнут = педаль отпущена)'
        },
        {
          channelNumber: 10,
          label: 'Режим мотора (10)',
          value: engine.rpm > 500 ? 1 : 0,
          unit: '',
          rawValue: engine.rpm > 500 ? 1 : 0,
          min: 0,
          max: 1,
          description: '1 = Двигатель запущен, 0 = Только зажигание'
        }
      ]
    },
    {
      groupNumber: 1,
      title: 'Группа 001 — Основные параметры работы',
      description: 'Главные параметры двигателя в физических величинах',
      channels: [
        {
          channelNumber: 1,
          label: 'Обороты двигателя',
          value: engine.rpm,
          unit: 'об/мин',
          rawValue: rpmRaw,
          min: 0,
          max: 6000,
          normalMin: 750,
          normalMax: 880,
          description: 'Частота вращения коленвала'
        },
        {
          channelNumber: 2,
          label: 'Температура ОЖ',
          value: engine.coolantTemp,
          unit: '°C',
          rawValue: coolantRaw,
          min: -40,
          max: 120,
          normalMin: 80,
          normalMax: 95,
          description: 'Температура антифриза'
        },
        {
          channelNumber: 3,
          label: 'Напряжение лямбды',
          value: engine.lambdaVoltage,
          unit: 'В',
          rawValue: Math.round((engine.lambdaVoltage / 1.0) * 255),
          min: 0.05,
          max: 0.95,
          normalMin: 0.1,
          normalMax: 0.9,
          description: 'Колебания сигнала кислородного датчика'
        },
        {
          channelNumber: 4,
          label: 'Статус регулирования',
          value: engine.idleSwitchClosed ? 1 : 0,
          unit: engine.idleSwitchClosed ? 'ХХ (F60 ВКЛ)' : 'НАГРУЗКА',
          rawValue: engine.idleSwitchClosed ? 1 : 0,
          min: 0,
          max: 1,
          description: 'Режим холостого хода или частичной нагрузки'
        }
      ]
    },
    {
      groupNumber: 2,
      title: 'Группа 002 — Впрыск и питание',
      description: 'Длительность импульса форсунки и напряжение питания',
      channels: [
        {
          channelNumber: 1,
          label: 'Обороты двигателя',
          value: engine.rpm,
          unit: 'об/мин',
          rawValue: rpmRaw,
          min: 0,
          max: 6000,
          normalMin: 750,
          normalMax: 880,
          description: 'Обороты'
        },
        {
          channelNumber: 2,
          label: 'Время впрыска',
          value: Number(engine.injectionTimeMs.toFixed(2)),
          unit: 'мс',
          rawValue: Math.round(engine.injectionTimeMs * 20),
          min: 0.5,
          max: 8.0,
          normalMin: 1.4,
          normalMax: 2.2,
          description: 'Длительность открытия форсунки N30'
        },
        {
          channelNumber: 3,
          label: 'Напряжение АКБ',
          value: Number(engine.batteryVoltage.toFixed(1)),
          unit: 'В',
          rawValue: batteryRaw,
          min: 9,
          max: 16,
          normalMin: 13.5,
          normalMax: 14.5,
          description: 'Напряжение клеммы 30'
        },
        {
          channelNumber: 4,
          label: 'Температура воздуха',
          value: engine.intakeTemp,
          unit: '°C',
          rawValue: Math.round(engine.intakeTemp * 1.5 + 40),
          min: -20,
          max: 70,
          normalMin: 15,
          normalMax: 50,
          description: 'Температура всасываемого воздуха G42'
        }
      ]
    },
    {
      groupNumber: 3,
      title: 'Группа 003 — Зажигание и дроссель',
      description: 'Угол зажигания и положение заслонки',
      channels: [
        {
          channelNumber: 1,
          label: 'Обороты двигателя',
          value: engine.rpm,
          unit: 'об/мин',
          rawValue: rpmRaw,
          min: 0,
          max: 6000,
          normalMin: 750,
          normalMax: 880,
          description: 'Обороты коленчатого вала'
        },
        {
          channelNumber: 2,
          label: 'Угол дросселя',
          value: Number(engine.throttleAngle.toFixed(1)),
          unit: '°',
          rawValue: throttleRaw,
          min: 0,
          max: 90,
          normalMin: 0,
          normalMax: 4.5,
          description: 'Угол открытия заслонки ДПДЗ'
        },
        {
          channelNumber: 3,
          label: 'Опережение зажигания',
          value: Number(engine.ignitionTimingDeg.toFixed(1)),
          unit: '° BTDC',
          rawValue: Math.round(engine.ignitionTimingDeg * 2.5),
          min: -5,
          max: 45,
          normalMin: 5,
          normalMax: 8,
          description: 'Текущий угол опережения зажигания ЭБУ'
        },
        {
          channelNumber: 4,
          label: 'Концевик ХХ F60',
          value: engine.idleSwitchClosed ? 1 : 0,
          unit: engine.idleSwitchClosed ? 'ЗАМКНУТ' : 'РАЗОМКНУТ',
          rawValue: engine.idleSwitchClosed ? 1 : 0,
          min: 0,
          max: 1,
          description: 'Контакт холостого хода'
        }
      ]
    }
  ];
}
