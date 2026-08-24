---
title: Modbus 协议与 Java 实现：工业设备采集第一课
description: Modbus RTU/TCP 帧格式、功能码、寄存器映射，用 Java 完整实现采集一台 PLC 的实战笔记
date: 2025-09-05
category: 工业物联网
tags: [Modbus, PLC, 工业协议, 数据采集]
order: 1
slug: modbus-java
featured: true
---

> 这是我在某压铸厂「设备上云」项目里的采集笔记。目标是把 30 台 PLC 和
> 60 多块电表的数据每 2 秒采一次上平台。第一周啃协议、第二周写代码、
> 第三周和现场工程师对着点位表逐点核对。下面写的东西，都是当时真正踩过的坑。

## 为什么工业现场绕不开 Modbus

Modbus 是 1979 年由 Modicon（后来的施耐德）发明的串行通信协议，1999 年成为公开规范。
2025 年了你做任何工业采集项目，设备清单里大概率仍有七八成设备自带 Modbus 口：

- **中小型 PLC**：西门子 S7-200 SMART、三菱 FX 系列、台达，几乎都内置 Modbus 从站；
- **智能电表**：威胜、科陆、安科瑞的导轨表，标配 Modbus 电能读写；
- **现场仪表**：流量计、温控器、压力变送器，多半有一个 RS485 + Modbus RTU 口。

对比一下 OPC UA：OPC UA 解决的是工厂不同厂商系统之间**语义互通**的问题，它有信息
建模、安全鉴权、订阅发布，适合 MES/SCADA 做异构集成。但对一块 200 块的流量计来说
它太重了——跑不起来，也没有必要。所以真实工厂的现状是：**现场粒度数据采集 Modbus
打底，OPC UA 走上层网关做协议转换**。做采集服务的人，Modbus 是绕不开的第一课。

## RTU 与 TCP：两种最常见的载体

Modbus 本身是应用层协议，底下可以跑 RS-485 串口（RTU），也可以跑以太网（TCP）。
两者的**数据部分（PDU）完全一样**，区别在封装和校验。

### RTU 帧格式

| 字段 | 长度 | 说明 |
| ---- | ---- | ---- |
| 从站地址 | 1 字节 | 1~247，0 为广播 |
| 功能码 | 1 字节 | 03 表示读保持寄存器 |
| 数据区 | N 字节 | 参数 + 数据，随功能码变化 |
| CRC16 | 2 字节 | 多项式 0xA001，**低字节在前** |

帧与帧之间要求至少 3.5 个字符的空闲时间，9600 波特下约 4ms。下面这条是
「读从站 1，保持寄存器偏移 0x6B（107）起 3 个寄存器」的完整报文：

```text
01 03 00 6B 00 03 68 0A
│  │  └─地址┘ └─数量┘ │
│  └─功能码            └─CRC16(低字节在前)
└─从站地址
```

CRC 是新手第一个坑：多项式、初值、字节序全对才拆得对包。后面给一段自写实现：

```java
// MODBUS 标准 CRC16：多项式 0xA001，初值 0xFFFF，输出低字节在前
public static byte[] crc16(byte[] data) {
    int crc = 0xFFFF;
    for (byte b : data) {
        crc ^= (b & 0xFF);
        for (int i = 0; i < 8; i++) {
            crc = (crc & 0x0001) != 0 ? (crc >> 1) ^ 0xA001 : crc >> 1;
        }
    }
    return new byte[]{(byte) (crc & 0xFF), (byte) ((crc >> 8) & 0xFF)};
}
```

拿上面那条报文试：`01 03 00 6B 00 03` 的 CRC 算出来就是 `68 0A`，对不上就检查
自己是不是把高低字节写反了。

### TCP 帧格式（MBAP + PDU）

| 字段 | 长度 | 说明 |
| ---- | ---- | ---- |
| 事务 ID | 2 字节 | 请求/响应配对，一般自增 |
| 协议 ID | 2 字节 | 恒为 0x0000 |
| 长度 | 2 字节 | 后面字节数 = 单元 ID + PDU |
| 单元 ID | 1 字节 | 网关后面挂多台从站时用 |
| PDU | N 字节 | 功能码 + 数据，与 RTU 相同 |

TCP 走以太网自带校验，**没有 CRC**。单元 ID 在直连 PLC 时填 1 就行，走串口网关
转接时它对应后面的从站地址。

### 功能码表（常用）

| 功能码 | 名称 | 操作对象 | 读写 | 备注 |
| ------ | ---- | ---- | ---- | ---- |
| 0x01 | 读线圈 Read Coils | 线圈 | 读 | 位操作，一次最多 2000 位 |
| 0x02 | 读离散输入 Read Discrete Inputs | 离散输入 | 只读 | 位操作 |
| 0x03 | 读保持寄存器 Read Holding Registers | 保持寄存器 | 读/写 | 最常用，一次最多 125 个 |
| 0x04 | 读输入寄存器 Read Input Registers | 输入寄存器 | 只读 | 仪表测量值常用 |
| 0x05 | 写单个线圈 Write Single Coil | 线圈 | 写 | FF00=ON，0000=OFF |
| 0x06 | 写单个寄存器 Write Single Register | 保持寄存器 | 写 | 下设定值用 |
| 0x0F(15) | 写多个线圈 Write Multiple Coils | 线圈 | 写 | |
| 0x10(16) | 写多个寄存器 Write Multiple Registers | 保持寄存器 | 写 | |

采集项目里 90% 的流量是 03，写参数偶尔用 06/10。

## 四类寄存器映射：先把地址空间搞清楚

| PLC 地址区间 | 类型 | 读写 | 数据精度 | 典型用途 |
| ------------ | ---- | ---- | ---- | ---- |
| 00001–09999 | 线圈 Coil | 可读可写 | 1 bit | 启停命令、故障复位 |
| 10001–19999 | 离散输入 Discrete Input | 只读 | 1 bit | 限位开关、运行状态 |
| 30001–39999 | 输入寄存器 Input Register | 只读 | 16 bit | 电流、频率等测量值 |
| 40001–49999 | 保持寄存器 Holding Register | 可读可写 | 16 bit | 设定值、累计量 |

**最经典的坑在这里**：PLC 屏幕上显示「40001」，协议里的偏移却是 **0**。也就是说
读 40001 寄存器，传给库的起始地址是 `40001 - 40001 = 0`；读 40100，协议地址是 99。
有些设备手册直接给十六进制偏移，比如 0x6B，那就别再做减法，直接用。

## 用 jlibmodbus 读保持寄存器：抄起来就能跑

### 为什么用现成库而不是自己写

自己写 Modbus 主站不是不行，但要处理的东西比想象多：CRC 高低字节、串口超时、
半包拆包、异常码映射、重连……第一版自写主站上线当天就被现场 90ms 超时的老 PLC
干趴了。jlibmodbus 是纯 Java、开源、同时支持 TCP/RTU/RTU-over-TCP，够用。备选有
modbus4j（功能全但更新慢）和 Jamod（2010 年后基本不维护，别用）。

依赖走 JitPack（正式仓库里没有，这也常被新人卡住）：

```xml
<repositories>
    <repository>
        <id>jitpack.io</id>
        <url>https://jitpack.io</url>
    </repository>
</repositories>

<dependency>
    <groupId>com.github.kochedykov</groupId>
    <artifactId>jlibmodbus</artifactId>
    <version>1.2.9.1</version>
</dependency>
```

> 版本以项目主页（github.com/kochedykov/jlibmodbus）为准；老版本 API 略有出入，
> 见过旧教程里用 `getTransport().openConnection()`，1.2.x 统一用 `connect()`。

### 完整读取代码

```java
import com.serotonin.modbus4j.ModbusMaster;
import com.serotonin.modbus4j.ModbusMasterFactory;
```

等等，上面是 modbus4j 的包名，jlibmodbus 的包名不一样，别混：

```java
import com.intelligt.modbus.jlibmodbus.ModbusMaster;
import com.intelligt.modbus.jlibmodbus.ModbusMasterFactory;
import com.intelligt.modbus.jlibmodbus.exception.ModbusIOException;
import com.intelligt.modbus.jlibmodbus.exception.ModbusProtocolException;

public class ReadHoldingRegistersSample {

    public static void main(String[] args) {
        // 采集服务器访问 PLC 的 502 端口（Modbus TCP 标准端口）
        ModbusMaster master = ModbusMasterFactory.createModbusMasterTCP("192.168.1.100", 502);

        try {
            master.connect();

            // 读从站 1：保持寄存器偏移 0（PLC 屏上显示 40001），读 3 个
            int[] values = master.readHoldingRegisters(1, 0, 3);

            for (int i = 0; i < values.length; i++) {
                System.out.printf("寄存器 400%02d = %d%n", i + 1, values[i]);
            }
        } catch (ModbusProtocolException e) {
            // 从站返回异常码：01 非法功能码 / 02 非法地址 / 03 非法数据 / 04 从站故障
            System.err.println("从站返回异常: " + e.getExceptionCode());
        } catch (ModbusIOException e) {
            // 网络超时/断连都归这一类，重连逻辑就在这补
            System.err.println("IO 异常: " + e.getMessage());
        } finally {
            try { master.disconnect(); } catch (Exception ignored) {}
        }
    }
}
```

### 参数逐个解释

- `createModbusMasterTCP(host, port)`：直连 PLC 时 port 填 502；走网关/防火墙口填
  实际映射端口，也有设备用 1502；
- `readHoldingRegisters(serverId, startAddress, quantity)`：
  - `serverId` = 从站地址。直连 PLC 通常为 1；网关后面挂多台从站时对着点位表填；
  - `startAddress` = **协议偏移**，不是 PLC 屏上的地址，见上文 40001 的坑；
  - `quantity` = 寄存器个数，1~125（Modbus 规范上限）。
- 返回值 `int[]`：每个元素是 16 位无符号值 0~65535。怎么变成物理量，见「工程单位换算」。

## 现场只有串口怎么办：RTU Master 初始化

很多厂里设备不上网，PLC 和电表挂在一条 RS-485 总线上。这时代码长相完全不同，
要指定串口参数，最常见的组合是 **9600 / 8 / N / 1**（波特率 9600、数据位 8、
无校验、停止位 1）：

```java
import com.intelligt.modbus.jlibmodbus.ModbusMaster;
import com.intelligt.modbus.jlibmodbus.ModbusMasterFactory;
import com.intelligt.modbus.jlibmodbus.serial.ModbusSerialParameters;

ModbusSerialParameters params = new ModbusSerialParameters();
params.setPortName("COM3");                                   // Windows；Linux 用 /dev/ttyUSB0
params.setBaudRate(ModbusSerialParameters.BAUDRATE_9600);
params.setDataBits(8);
params.setStopBits(1);
params.setParity(ModbusSerialParameters.NO_PARITY);           // N=无校验

ModbusMaster master = ModbusMasterFactory.createModbusMasterRTU(params);
master.connect();                                             // 打开串口（阻塞）
int[] values = master.readHoldingRegisters(1, 0, 10);         // 后续调用与 TCP 一致
```

几个串口的现实问题：

- 电脑没串口就用 USB-RS485 转换器，Linux 下枚举成 `/dev/ttyUSB0`，要注意权限；
- 9600 波特率下一个字节约 1.15ms，读 10 个寄存器的事务往返约 30~80ms。轮询多台
  设备时先算时间预算（见后面的坑三）；
- RS-485 是**一主多从**，同一时间只能有一个主站发言，调试期间别让两台电脑同时
  挂在总线上读同一台设备，会互相干扰把从站搞"卡死"。

## 工程单位换算：原始值到真实物理量

寄存器里的 16 位整数通常不是物理量本身，要按点位表乘缩放系数。比如温度：

```java
// 点位表：40001 = 1# 压铸机模温，缩放系数 0.1，单位 ℃，可正可负
int raw = master.readHoldingRegisters(1, 0, 1)[0];

// 注意：PLC 里 -50 存成 0xFFCE。raw 是无符号读上来的 65486，直接乘 0.1 就错了
short signed = (short) raw;            // 强转成有符号 int16
double temp = signed * 0.1;            // -5.0 ℃，而不是 6548.6

System.out.printf("模温 = %.1f ℃%n", temp);
```

负温/负压场景下，**先把 uint16 按 int16 解释再换算**，这是点位核对时最容易翻车
的一步。另外不少进口仪表把 32 位浮点拆到两个寄存器里，字节序还有 ABC D 和
CD AB 两种排法，遇到双寄存器点位时先拿已知值验一遍再批量接。

## 踩坑记录

### 坑一：字节序高低位颠倒

调试时读 40002 压力，点位表写着应该 5.0MPa，读回来 0x0500 即 1280。原因是设备
按**高低字节反着存**，或者读回来低字节在前。两个寄存器以上的点位（32 位整数、
浮点）先打印原始字节确认：

```java
int raw = values[0];
int swapped = ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF);   // 交换高低字节
```

引脚表核对：**先确认单寄存器点位没错，再怀疑字节序；先确认字节序，再怀疑缩放
系数**，别上来就改代码。

### 坑二：断连重连策略

PLC 重启、网线松动、网关断电都会让 TCP 连接失效。ModbusIOException 一出现就要
走重连，而且**退避重试**，别死循环猛连把设备/网关打挂：

```java
private static final int MAX_RETRY = 5;
private static final long BASE_BACKOFF_MS = 1000;

int[] readWithRetry(ModbusMaster master, int slaveId, int addr, int qty) throws ModbusIOException {
    for (int i = 0; i < MAX_RETRY; i++) {
        try {
            if (!master.isConnected()) {
                master.connect();
            }
            return master.readHoldingRegisters(slaveId, addr, qty);
        } catch (ModbusIOException e) {
            log.warn("第 {} 次读取失败: {}", i + 1, e.getMessage());
            quietDisconnect(master);
            sleep(BASE_BACKOFF_MS << i);   // 1s, 2s, 4s, 8s, 16s
        }
    }
    throw new ModbusIOException("连续 " + MAX_RETRY + " 次读取失败，设备可能下线");
}
```

串口设备重连还要记得把串口**彻底关闭再打开**，USB 转接头在打开失败后等 1~2 秒
再重试，否则端口会一直报 busy。

### 坑三：轮询周期与设备负载

轮询不是越快越好。几个实测结论：

- 老 PLC（S7-200 SMART 这类）单事务处理要 10~50ms，轮询间隔低于 200ms 时偶发
  无响应；
- 9600 波特率下 60 台设备一轮全查要 2~5 秒，想 2 秒周期要么把慢速表单独拆出去
  降频，要么升 19200/38400，要么设备改走 TCP；
- **错峰**：每台设备轮询起点加个固定偏移（如 `deviceIndex * 300ms`），否则所有
  设备同时发请求，串口忙不过来，看波形全是间隔 11ms 的密集包。

| 参数 | 我的最终取值 | 理由 |
| ---- | ---- | ---- |
| TCP 轮询间隔 | 1000ms | PLC 处理能力 + 平台 2s 周期有余量 |
| RTU 轮询间隔 | 500ms | 单事务 ~40ms，60 台一轮 ~2.4s |
| 读超时 | 1000ms | 小于轮询间隔，避免重试堆积 |
| CRC 校验失败重发 | 1 次 | 串口受干扰常见，多试反而拖慢 |

## 小结

Modbus 不难，难在那些"不说就不知道"的细节：40001 对 0 偏移、CRC 低字节在前、
uint16 与 int16、字节序、重连策略、轮询预算。把这篇文章里的表格和代码过一遍，
去现场接第一台 PLC，应该能少走一半弯路。下一篇我会写这条链路的后半段：采集到
的数据怎么经过消息队列批量落库，做成一整套采集平台。原文 `modbus-java`，欢迎
收藏。