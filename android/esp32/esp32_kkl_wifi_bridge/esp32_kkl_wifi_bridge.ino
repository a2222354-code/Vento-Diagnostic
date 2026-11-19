/*
 * VAG KWP1281 Wi-Fi <-> USB KKL Bridge для ESP32-S3 (Native USB Host OTG)
 * Совместим с Android-приложением "Vento Diagnostic" (VW Vento 1995 1.8 ADZ / Mono-Motronic 1.2.3)
 *
 * Аппаратная часть:
 *   Плата: ESP32-S3 (со встроенным USB OTG Host, например ESP32-S3-DevKitC-1 / N16R8)
 *   Кабель: KKL VAG-COM 409.1 USB (FTDI FT232RL/RQ, WCH CH340, Silicon Labs CP2102)
 *   Подключение:
 *     1. KKL USB кабель подключается через OTG-переходник к порту USB-OTG платы ESP32-S3.
 *     2. Питание +5V на шину VBUS OTG (на DevKitC обычно через второй порт UART/5V или перемычку VBUS/5V-IN).
 *     3. KKL вставляется в OBD-II разъём автомобиля (питание 12В берётся с авто).
 *
 * Настройки Arduino IDE (инструменты):
 *   Board: "ESP32S3 Dev Module"
 *   USB Mode: "Hardware CDC and JTAG" (чтобы порт USB-OTG был свободен для режима Host)
 *   USB CDC On Boot: "Disabled" (или через UART0 порт для логов Serial)
 *
 * Подключение со смартфона:
 *   Wi-Fi сеть (Точка доступа ESP32): SSID = "VENTO-KKL-WIFI", Пароль = "ventokkl"
 *   TCP Адрес: 192.168.4.1, Порт: 3333
 */

#include <WiFi.h>
#include <esp_timer.h>
#include "usb/usb_host.h"

// ================= НАСТРОЙКИ WI-FI =================
static const char* AP_SSID = "VENTO-KKL-WIFI";
static const char* AP_PASS = "ventokkl";
static const uint16_t TCP_PORT = 3333;

// При необходимости подключения к домашнему роутеру укажите данные ниже:
static const bool USE_STA_WIFI = false;
static const char* STA_SSID = "YOUR_ROUTER_SSID";
static const char* STA_PASS = "YOUR_ROUTER_PASS";

// ================= БИНАРНЫЙ ПРОТОКОЛ =================
#define PROTO_MAGIC     0xAA
#define CMD_5BAUD_INIT  0x01
#define CMD_TX_DATA     0x02
#define CMD_CLEAR_BUF   0x03
#define CMD_PING_INFO   0x04

#define RSP_5BAUD_DONE  0x81
#define RSP_RX_DATA     0x82
#define RSP_INFO        0x84

enum KklChipType {
  CHIP_NONE = 0,
  CHIP_FTDI = 1,   // VID 0x0403
  CHIP_CH340 = 2,  // VID 0x1A86
  CHIP_CP210X = 3  // VID 0x10C4
};

// ================= ГЛОБАЛЬНЫЕ ОБЪЕКТЫ =================
WiFiServer tcpServer(TCP_PORT);
WiFiClient tcpClient;

static usb_host_client_handle_t usbClientHandle = nullptr;
static usb_device_handle_t usbDevHandle = nullptr;
static volatile bool hasNewUsbDev = false;
static volatile uint8_t pendingNewDevAddr = 0;
static volatile bool usbNeedClose = false;
static volatile bool usbDeviceReady = false;

static KklChipType chipType = CHIP_NONE;
static uint16_t usbVid = 0;
static uint16_t usbPid = 0;
static uint8_t claimedIface = 0;
static uint8_t epInAddr = 0;
static uint16_t epInMps = 64;
static uint8_t epOutAddr = 0;

static usb_transfer_t* ctrlTransfer = nullptr;
static usb_transfer_t* rxTransfer = nullptr;
static usb_transfer_t* txTransfer = nullptr;
static SemaphoreHandle_t ctrlSem = nullptr;
static SemaphoreHandle_t txSem = nullptr;
static volatile bool ctrlOk = false;

// Кольцевой буфер приёма UART от KKL кабеля
#define RX_RING_SIZE 2048
static uint8_t rxRing[RX_RING_SIZE];
static volatile uint16_t rxHead = 0;
static volatile uint16_t rxTail = 0;
static portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;

static void pushRxBytes(const uint8_t* data, size_t len) {
  if (len == 0) return;
  portENTER_CRITICAL(&rxMux);
  for (size_t i = 0; i < len; i++) {
    uint16_t next = (rxHead + 1) % RX_RING_SIZE;
    if (next != rxTail) {
      rxRing[rxHead] = data[i];
      rxHead = next;
    }
  }
  portEXIT_CRITICAL(&rxMux);
}

static size_t popRxBytes(uint8_t* out, size_t maxLen) {
  size_t count = 0;
  portENTER_CRITICAL(&rxMux);
  while (rxTail != rxHead && count < maxLen) {
    out[count++] = rxRing[rxTail];
    rxTail = (rxTail + 1) % RX_RING_SIZE;
  }
  portEXIT_CRITICAL(&rxMux);
  return count;
}

static void clearRxRing() {
  portENTER_CRITICAL(&rxMux);
  rxHead = 0;
  rxTail = 0;
  portEXIT_CRITICAL(&rxMux);
}

// ================= USB CALLBACKS =================
static void onCtrlComplete(usb_transfer_t* transfer) {
  ctrlOk = (transfer->status == USB_TRANSFER_STATUS_COMPLETED);
  if (ctrlSem) xSemaphoreGive(ctrlSem);
}

static void onTxComplete(usb_transfer_t* transfer) {
  if (txSem) xSemaphoreGive(txSem);
}

static void onRxComplete(usb_transfer_t* transfer) {
  if (transfer->status == USB_TRANSFER_STATUS_COMPLETED && transfer->actual_num_bytes > 0) {
    if (chipType == CHIP_FTDI) {
      // FTDI добавляет 2 статусных байта модема в начало каждого Bulk IN пакета
      if (transfer->actual_num_bytes > 2) {
        pushRxBytes(transfer->data_buffer + 2, transfer->actual_num_bytes - 2);
      }
    } else {
      pushRxBytes(transfer->data_buffer, transfer->actual_num_bytes);
    }
  }
  if (usbDeviceReady && usbDevHandle != nullptr && transfer->status != USB_TRANSFER_STATUS_CANCELED) {
    esp_err_t err = usb_host_transfer_submit(transfer);
    if (err != ESP_OK) {
      // Будет перезапущено при следующем переподключении USB
    }
  }
}

static void usbClientEventCallback(const usb_host_client_event_msg_t* event_msg, void* arg) {
  if (event_msg->event == USB_HOST_CLIENT_EVENT_NEW_DEV) {
    pendingNewDevAddr = event_msg->new_dev.address;
    hasNewUsbDev = true;
  } else if (event_msg->event == USB_HOST_CLIENT_EVENT_DEV_GONE) {
    usbDeviceReady = false;
    usbNeedClose = true;
  }
}

// ================= УПРАВЛЕНИЕ ЧИПАМИ USB-KKL =================
static bool sendControlTransfer(
    uint8_t bmRequestType,
    uint8_t bRequest,
    uint16_t wValue,
    uint16_t wIndex,
    const uint8_t* data = nullptr,
    uint16_t wLength = 0) {
  if (!usbDevHandle || !ctrlTransfer || !ctrlSem) return false;
  if (sizeof(usb_setup_packet_t) + wLength > 64) return false;

  // Сбрасываем семафор перед запуском
  xSemaphoreTake(ctrlSem, 0);

  usb_setup_packet_t* setup = (usb_setup_packet_t*)ctrlTransfer->data_buffer;
  setup->bmRequestType = bmRequestType;
  setup->bRequest = bRequest;
  setup->wValue = wValue;
  setup->wIndex = wIndex;
  setup->wLength = wLength;

  if (data != nullptr && wLength > 0) {
    memcpy(ctrlTransfer->data_buffer + sizeof(usb_setup_packet_t), data, wLength);
  }

  ctrlTransfer->device_handle = usbDevHandle;
  ctrlTransfer->bEndpointAddress = 0;
  ctrlTransfer->num_bytes = sizeof(usb_setup_packet_t) + wLength;
  ctrlTransfer->callback = onCtrlComplete;
  ctrlTransfer->context = nullptr;
  ctrlOk = false;

  if (usb_host_transfer_submit_control(usbClientHandle, ctrlTransfer) != ESP_OK) {
    return false;
  }
  if (xSemaphoreTake(ctrlSem, pdMS_TO_TICKS(300)) != pdTRUE) {
    return false;
  }
  return ctrlOk;
}

static bool kklSetBaud(uint16_t baud) {
  if (chipType == CHIP_FTDI) {
    // Базовая частота FTDI = 3000000 Гц
    // 9600 бод: 3000000/9600 = 312.5 -> 0x4138; 10400 бод: 3000000/10400 = 288.46 -> 0x4120
    uint16_t wValue = (baud == 10400) ? 0x4120 : 0x4138;
    return sendControlTransfer(0x40, 0x03, wValue, 0x0000);
  } else if (chipType == CHIP_CH340) {
    // CH340 clock prescaler 2 (750 kHz): 9600 -> 0xB202, 10400 -> 0xB802
    uint16_t wIndex = (baud == 10400) ? 0xB802 : 0xB202;
    return sendControlTransfer(0x40, 0x9A, 0x1312, wIndex);
  } else if (chipType == CHIP_CP210X) {
    uint32_t b = baud;
    return sendControlTransfer(0x41, 0x1E, 0x0000, 0x0000, (const uint8_t*)&b, 4);
  }
  return false;
}

static bool kklSetBreak(bool breakOn) {
  if (chipType == CHIP_FTDI) {
    // 8N1 (0x0008) + Bit 14 (0x4000) для Break ON
    uint16_t wValue = breakOn ? 0x4008 : 0x0008;
    return sendControlTransfer(0x40, 0x04, wValue, 0x0001);
  } else if (chipType == CHIP_CH340) {
    // Регистр 0x05 в CH340: 0x0000 = Break ON, 0x0101 = Break OFF
    uint16_t wIndex = breakOn ? 0x0000 : 0x0101;
    return sendControlTransfer(0x40, 0x9A, 0x0505, wIndex);
  } else if (chipType == CHIP_CP210X) {
    return sendControlTransfer(0x41, 0x05, breakOn ? 1 : 0, 0x0000);
  }
  return false;
}

static bool kklInitUart(uint16_t baud) {
  if (chipType == CHIP_FTDI) {
    sendControlTransfer(0x40, 0x00, 0x0000, 0x0001); // Reset
    kklSetBaud(baud);
    sendControlTransfer(0x40, 0x04, 0x0008, 0x0001); // 8N1, Break OFF
    sendControlTransfer(0x40, 0x01, 0x0303, 0x0001); // DTR=1, RTS=1
    sendControlTransfer(0x40, 0x09, 0x0001, 0x0001); // Latency Timer = 1 мс
    return true;
  } else if (chipType == CHIP_CH340) {
    sendControlTransfer(0x40, 0xA1, 0x0000, 0x0000);
    sendControlTransfer(0x40, 0x9A, 0x2518, 0x00C3); // 8N1
    kklSetBaud(baud);
    sendControlTransfer(0x40, 0xA4, (uint16_t)~((1 << 5) | (1 << 6)), 0x0000); // DTR+RTS active
    kklSetBreak(false);
    return true;
  } else if (chipType == CHIP_CP210X) {
    sendControlTransfer(0x41, 0x00, 0x0001, 0x0000); // UART Enable
    kklSetBaud(baud);
    sendControlTransfer(0x41, 0x03, 0x0800, 0x0000); // 8N1
    sendControlTransfer(0x41, 0x07, 0x0303, 0x0000); // DTR=1, RTS=1
    kklSetBreak(false);
    return true;
  }
  return false;
}

static void kklPurgeBuffers() {
  clearRxRing();
  if (chipType == CHIP_FTDI) {
    sendControlTransfer(0x40, 0x00, 0x0001, 0x0001); // Purge RX
    sendControlTransfer(0x40, 0x00, 0x0002, 0x0001); // Purge TX
  }
}

static bool kklWriteBytes(const uint8_t* data, size_t len) {
  if (!usbDeviceReady || !usbDevHandle || !txTransfer || !txSem || len == 0 || len > 250) {
    return false;
  }
  if (xSemaphoreTake(txSem, pdMS_TO_TICKS(200)) != pdTRUE) {
    return false;
  }
  memcpy(txTransfer->data_buffer, data, len);
  txTransfer->device_handle = usbDevHandle;
  txTransfer->bEndpointAddress = epOutAddr;
  txTransfer->num_bytes = len;
  txTransfer->callback = onTxComplete;
  txTransfer->context = nullptr;

  esp_err_t err = usb_host_transfer_submit(txTransfer);
  if (err != ESP_OK) {
    xSemaphoreGive(txSem);
    return false;
  }
  return true;
}

// Высокоточная 5-бодовая инициализация (200.0 мс на бит по аппаратному esp_timer)
static bool execute5BaudInit(uint8_t address, uint16_t targetBaud) {
  if (!usbDeviceReady) return false;

  kklInitUart(targetBaud);
  kklSetBreak(false); // Idle HIGH (12В на K-Line)
  delay(250);

  const int64_t BIT_US = 200000LL; // 200.0 мс
  int64_t tStart = esp_timer_get_time();

  auto waitDeadline = [&](int stepIndex) {
    int64_t deadline = tStart + (stepIndex * BIT_US);
    while (esp_timer_get_time() < deadline) {
      int64_t remMs = (deadline - esp_timer_get_time()) / 1000LL;
      if (remMs > 8) {
        delay((uint32_t)(remMs - 4));
      }
    }
  };

  // 1. Старт-бит: LOW (Break ON)
  kklSetBreak(true);
  waitDeadline(1);

  // 2..8. 7 бит адреса (LSB first, 7O1)
  uint8_t parity = 0;
  for (int i = 0; i < 7; i++) {
    uint8_t bit = (address >> i) & 0x01;
    parity ^= bit;
    kklSetBreak(bit == 0);
    waitDeadline(2 + i);
  }

  // 9. Бит нечётности (Odd parity)
  uint8_t parityBit = (parity != 0) ? 0 : 1;
  kklSetBreak(parityBit == 0);
  waitDeadline(9);

  // 10. Стоп-бит: HIGH (Break OFF)
  kklSetBreak(false);
  waitDeadline(10);

  // 11. Пауза 25 мс и переключение в штатный режим 8N1
  delay(25);
  kklInitUart(targetBaud);
  kklPurgeBuffers();
  return true;
}

// ================= ОТКРЫТИЕ / ЗАКРЫТИЕ USB УСТРОЙСТВА =================
static void closeCurrentUsbDevice() {
  usbDeviceReady = false;
  chipType = CHIP_NONE;
  usbVid = 0;
  usbPid = 0;
  if (usbDevHandle != nullptr) {
    usb_host_interface_release(usbClientHandle, usbDevHandle, claimedIface);
    usb_host_device_close(usbClientHandle, usbDevHandle);
    usbDevHandle = nullptr;
  }
}

static void openNewUsbDevice(uint8_t devAddr) {
  closeCurrentUsbDevice();

  if (usb_host_device_open(usbClientHandle, devAddr, &usbDevHandle) != ESP_OK) {
    return;
  }

  const usb_device_desc_t* devDesc = nullptr;
  if (usb_host_get_device_descriptor(usbDevHandle, &devDesc) != ESP_OK || devDesc == nullptr) {
    closeCurrentUsbDevice();
    return;
  }

  usbVid = devDesc->idVendor;
  usbPid = devDesc->idProduct;

  if (usbVid == 0x0403) chipType = CHIP_FTDI;
  else if (usbVid == 0x1A86) chipType = CHIP_CH340;
  else if (usbVid == 0x10C4) chipType = CHIP_CP210X;
  else {
    Serial.printf("Неподдерживаемое USB устройство: VID=0x%04X PID=0x%04X\n", usbVid, usbPid);
    closeCurrentUsbDevice();
    return;
  }

  const usb_config_desc_t* configDesc = nullptr;
  if (usb_host_get_active_config_descriptor(usbDevHandle, &configDesc) != ESP_OK || configDesc == nullptr) {
    closeCurrentUsbDevice();
    return;
  }

  epInAddr = 0;
  epOutAddr = 0;
  epInMps = 64;
  claimedIface = 0;
  uint8_t curIface = 0;

  uint16_t offset = 0;
  const uint8_t* raw = (const uint8_t*)configDesc;
  while (offset < configDesc->wTotalLength) {
    uint8_t bLen = raw[offset];
    uint8_t bType = raw[offset + 1];
    if (bLen == 0) break;

    if (bType == USB_B_DESCRIPTOR_TYPE_INTERFACE) {
      const usb_intf_desc_t* intf = (const usb_intf_desc_t*)(raw + offset);
      curIface = intf->bInterfaceNumber;
    } else if (bType == USB_B_DESCRIPTOR_TYPE_ENDPOINT) {
      const usb_ep_desc_t* ep = (const usb_ep_desc_t*)(raw + offset);
      if ((ep->bmAttributes & 0x03) == 0x02) { // Bulk endpoint
        if ((ep->bEndpointAddress & 0x80) != 0 && epInAddr == 0) {
          epInAddr = ep->bEndpointAddress;
          epInMps = ep->wMaxPacketSize;
          claimedIface = curIface;
        } else if ((ep->bEndpointAddress & 0x80) == 0 && epOutAddr == 0) {
          epOutAddr = ep->bEndpointAddress;
        }
      }
    }
    offset += bLen;
  }

  if (epInAddr == 0 || epOutAddr == 0) {
    closeCurrentUsbDevice();
    return;
  }

  if (usb_host_interface_claim(usbClientHandle, usbDevHandle, claimedIface, 0) != ESP_OK) {
    closeCurrentUsbDevice();
    return;
  }

  kklInitUart(9600);
  kklPurgeBuffers();
  usbDeviceReady = true;

  if (rxTransfer) {
    usb_host_transfer_free(rxTransfer);
    rxTransfer = nullptr;
  }
  if (usb_host_transfer_alloc(epInMps, 0, &rxTransfer) == ESP_OK) {
    rxTransfer->device_handle = usbDevHandle;
    rxTransfer->bEndpointAddress = epInAddr;
    rxTransfer->num_bytes = epInMps;
    rxTransfer->callback = onRxComplete;
    rxTransfer->context = nullptr;
    usb_host_transfer_submit(rxTransfer);
  }

  Serial.printf("USB KKL подключён! VID=0x%04X PID=0x%04X (chip=%d)\n", usbVid, usbPid, (int)chipType);
}

// ================= ЗАДАЧИ FREERTOS ДЛЯ USB HOST =================
static void usbHostLibTask(void* arg) {
  while (true) {
    uint32_t eventFlags = 0;
    usb_host_lib_handle_events(portMAX_DELAY, &eventFlags);
  }
}

static void usbClientTask(void* arg) {
  usb_host_client_config_t clientCfg = {
    .is_synchronous = false,
    .max_num_event_msg = 5,
    .async = {
      .client_event_callback = usbClientEventCallback,
      .callback_arg = nullptr
    }
  };
  ESP_ERROR_CHECK(usb_host_client_register(&clientCfg, &usbClientHandle));

  while (true) {
    usb_host_client_handle_events(usbClientHandle, pdMS_TO_TICKS(10));
    if (hasNewUsbDev) {
      hasNewUsbDev = false;
      openNewUsbDevice(pendingNewDevAddr);
    }
    if (usbNeedClose) {
      usbNeedClose = false;
      closeCurrentUsbDevice();
      Serial.println("USB KKL отключён.");
    }
  }
}

// ================= ОТПРАВКА КАДРОВ ПО TCP =================
static void sendTcpInfoResponse() {
  if (!tcpClient || !tcpClient.connected()) return;
  uint8_t rsp[7] = {
    PROTO_MAGIC,
    RSP_INFO,
    (uint8_t)(usbDeviceReady ? 1 : 0),
    (uint8_t)((usbVid >> 8) & 0xFF),
    (uint8_t)(usbVid & 0xFF),
    (uint8_t)((usbPid >> 8) & 0xFF),
    (uint8_t)(usbPid & 0xFF)
  };
  tcpClient.write(rsp, sizeof(rsp));
  tcpClient.flush();
}

static void sendTcp5BaudResponse(bool ok, uint8_t errCode) {
  if (!tcpClient || !tcpClient.connected()) return;
  uint8_t rsp[4] = {
    PROTO_MAGIC,
    RSP_5BAUD_DONE,
    (uint8_t)(ok ? 1 : 0),
    errCode
  };
  tcpClient.write(rsp, sizeof(rsp));
  tcpClient.flush();
}

static void forwardUsbRxToTcp() {
  if (!tcpClient || !tcpClient.connected()) return;
  uint8_t buf[240];
  size_t n = popRxBytes(buf, sizeof(buf));
  if (n > 0) {
    uint8_t hdr[3] = { PROTO_MAGIC, RSP_RX_DATA, (uint8_t)n };
    tcpClient.write(hdr, 3);
    tcpClient.write(buf, n);
    tcpClient.flush();
  }
}

static int readTcpByteBlocking(uint32_t timeoutMs = 200) {
  uint32_t start = millis();
  while (tcpClient.connected()) {
    if (tcpClient.available() > 0) {
      return tcpClient.read();
    }
    if (millis() - start >= timeoutMs) return -1;
    delay(1);
  }
  return -1;
}

static void handleIncomingTcpCommands() {
  while (tcpClient && tcpClient.connected() && tcpClient.available() > 0) {
    int magic = tcpClient.read();
    if (magic != PROTO_MAGIC) continue;

    int cmd = readTcpByteBlocking();
    if (cmd < 0) break;

    switch (cmd) {
      case CMD_5BAUD_INIT: {
        int addr = readTcpByteBlocking();
        int bHi = readTcpByteBlocking();
        int bLo = readTcpByteBlocking();
        if (addr < 0 || bHi < 0 || bLo < 0) break;

        uint16_t baud = ((uint16_t)(bHi & 0xFF) << 8) | (uint16_t)(bLo & 0xFF);
        if (!usbDeviceReady) {
          sendTcp5BaudResponse(false, 1);
        } else {
          bool ok = execute5BaudInit((uint8_t)addr, baud);
          sendTcp5BaudResponse(ok, ok ? 0 : 3);
        }
        break;
      }

      case CMD_TX_DATA: {
        int len = readTcpByteBlocking();
        if (len <= 0 || len > 240) break;
        uint8_t txBuf[240];
        bool complete = true;
        for (int i = 0; i < len; i++) {
          int b = readTcpByteBlocking();
          if (b < 0) { complete = false; break; }
          txBuf[i] = (uint8_t)b;
        }
        if (complete && usbDeviceReady) {
          kklWriteBytes(txBuf, (size_t)len);
        }
        break;
      }

      case CMD_CLEAR_BUF: {
        if (usbDeviceReady) kklPurgeBuffers();
        else clearRxRing();
        break;
      }

      case CMD_PING_INFO: {
        sendTcpInfoResponse();
        break;
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n=== VENTO KWP1281 ESP32-S3 WI-FI BRIDGE ===");

  ctrlSem = xSemaphoreCreateBinary();
  txSem = xSemaphoreCreateBinary();
  xSemaphoreGive(txSem);

  usb_host_config_t hostCfg = {
    .skip_phy_setup = false,
    .intr_flags = ESP_INTR_FLAG_LEVEL1
  };
  ESP_ERROR_CHECK(usb_host_install(&hostCfg));

  ESP_ERROR_CHECK(usb_host_transfer_alloc(64, 0, &ctrlTransfer));
  ESP_ERROR_CHECK(usb_host_transfer_alloc(256, 0, &txTransfer));

  xTaskCreatePinnedToCore(usbHostLibTask, "usb_host_lib", 4096, nullptr, 5, nullptr, 0);
  xTaskCreatePinnedToCore(usbClientTask, "usb_client", 4096, nullptr, 5, nullptr, 0);

  if (USE_STA_WIFI) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(STA_SSID, STA_PASS);
    Serial.printf("Подключение к Wi-Fi %s", STA_SSID);
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 12000) {
      delay(300);
      Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      Serial.print("IP адрес ESP32: ");
      Serial.println(WiFi.localIP());
    }
  } else {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    Serial.printf("Точка доступа запущена: SSID=%s PASS=%s\n", AP_SSID, AP_PASS);
    Serial.print("IP адрес моста: ");
    Serial.println(WiFi.softAPIP());
  }

  WiFi.setSleep(false); // Отключаем энергосбережение Wi-Fi для минимальной задержки K-Line
  tcpServer.begin();
  tcpServer.setNoDelay(true);
  Serial.printf("TCP сервер KWP1281 слушает порт %u\n", TCP_PORT);
}

void loop() {
  if (tcpServer.hasClient()) {
    WiFiClient newClient = tcpServer.available();
    if (newClient) {
      if (tcpClient && tcpClient.connected()) {
        tcpClient.stop();
      }
      tcpClient = newClient;
      tcpClient.setNoDelay(true);
      clearRxRing();
      Serial.println("Android клиент подключён по Wi-Fi!");
    }
  }

  if (tcpClient && tcpClient.connected()) {
    handleIncomingTcpCommands();
    forwardUsbRxToTcp();
    if (!tcpClient.available() && rxHead == rxTail) {
      delay(1);
    }
  } else if (tcpClient) {
    tcpClient.stop();
    if (usbDeviceReady) kklSetBreak(false);
    Serial.println("Android клиент отключён.");
    delay(1);
  } else {
    delay(1);
  }
}
