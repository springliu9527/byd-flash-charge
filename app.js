/**
 * 比亚迪闪充演示：双枪并行 + 站端储电柜；第二代刀片电池车型标称参数用于车端 kW/kWh 输入。
 * 能量账：本帧自动补能先入柜（gridChargeKw·dt/3600 kWh），再以补后存量 sMid 算可放预算；两车车端 dE0+dE1 从柜体扣减 (dE0+dE1)/η。
 * 功率：先按车端能力与曲线得 P_raw，双枪合计不超过「兆瓦桩端上限」按比例压缩，再受储电柜可放电预算约束。
 */
(function () {
  'use strict';

  const RING_C = 2 * Math.PI * 52;
  const EPS = 1e-4;
  // 为了“柜里还有能量就继续冲”，避免因 SOC 增量阈值过大而提前停枪
  const SOC_START_MIN_DELTA_PCT = 0.005;
  const SOC_DONE_TOL_PCT = 0.005;

  const VEHICLE_PRESETS = {
    // 车端峰值 kW：按「兆瓦闪充 + 第二代刀片」演示口径调高（双枪易顶满 1MW 桩）；非实测数据
    'byd-han-ev': { name: '比亚迪 汉 EV（第二代刀片电池 · 闪充演示）', cap: 85.4, maxKw: 520 },
    'byd-seal': { name: '比亚迪 海豹（第二代刀片电池 · 闪充演示）', cap: 82.5, maxKw: 500 },
    'byd-qin-plus-ev': { name: '比亚迪 秦 PLUS EV（第二代刀片电池 · 闪充演示）', cap: 57.6, maxKw: 380 },
    'byd-dolphin': { name: '比亚迪 海豚（第二代刀片电池 · 闪充演示）', cap: 44.9, maxKw: 320 },
    'tesla-model-y': { name: '特斯拉 Model Y（长续航）', cap: 78.4, maxKw: 250 },
    'tesla-model-3': { name: '特斯拉 Model 3（长续航）', cap: 75, maxKw: 250 },
    'nio-et5': { name: '蔚来 ET5 / ET5T', cap: 75, maxKw: 180 },
    'xpeng-g6': { name: '小鹏 G6（755 超长续航）', cap: 87.5, maxKw: 280 },
    'zeekr-001': { name: '极氪 001（100 kWh）', cap: 100, maxKw: 200 },
    'xiaomi-su7': { name: '小米 SU7（后驱长续航）', cap: 73.6, maxKw: 220 },
    'aion-y-plus': { name: '埃安 AION Y Plus', cap: 63.98, maxKw: 120 },
    'vw-id4-crozz': { name: '大众 ID.4 CROZZ（长续航）', cap: 84.8, maxKw: 135 },
  };

  const el = {
    cabinetRemaining: document.getElementById('cabinetRemaining'),
    cabinetPercent: document.getElementById('cabinetPercent'),
    cabinetBar: document.getElementById('cabinetBar'),
    cabinetStatus: document.getElementById('cabinetStatus'),
    cabinetDrainTimeDisplay: document.getElementById('cabinetDrainTimeDisplay'),
    cabinetRated: document.getElementById('cabinetRated'),
    cabinetEta: document.getElementById('cabinetEta'),
    gridChargeKw: document.getElementById('gridChargeKw'),
    drainToEmpty: document.getElementById('drainToEmpty'),
    stationMaxKw: document.getElementById('stationMaxKw'),
    completedCount: document.getElementById('completedCount'),
    totalDelivered: document.getElementById('totalDelivered'),
    sessionDeliveredA: document.getElementById('sessionDeliveredA'),
    sessionDeliveredB: document.getElementById('sessionDeliveredB'),
    sessionDeliveredSum: document.getElementById('sessionDeliveredSum'),
    autoChain: document.getElementById('autoChain'),
    speed: document.getElementById('speed'),
    vehicleModel: document.getElementById('vehicleModel'),
    vehicleSpecLine: document.getElementById('vehicleSpecLine'),
    socStartInput: document.getElementById('socStartInput'),
    socTargetInput: document.getElementById('socTargetInput'),
    effectiveTargetHint: document.getElementById('effectiveTargetHint'),
    vehicleNoteDisplay: document.getElementById('vehicleNoteDisplay'),
    totalPowerDisplay: document.getElementById('totalPowerDisplay'),
    totalPowerMw: document.getElementById('totalPowerMw'),
    btnStart: document.getElementById('btnStart'),
    btnPause: document.getElementById('btnPause'),
    btnNext: document.getElementById('btnNext'),
    btnCabinetFull: document.getElementById('btnCabinetFull'),
    btnClearStats: document.getElementById('btnClearStats'),
    btnAbortSession: document.getElementById('btnAbortSession'),
    btnResetAll: document.getElementById('btnResetAll'),
    turnaroundSimSec: document.getElementById('turnaroundSimSec'),
    stallBLagSimSec: document.getElementById('stallBLagSimSec'),
  };

  const stallUi = [0, 1].map((i) => ({
    socRing: document.getElementById(`stall${i}SocRing`),
    socDisplay: document.getElementById(`stall${i}SocDisplay`),
    powerDisplay: document.getElementById(`stall${i}PowerDisplay`),
    voltDisplay: document.getElementById(`stall${i}VoltDisplay`),
    ampDisplay: document.getElementById(`stall${i}AmpDisplay`),
    etaDisplay: document.getElementById(`stall${i}EtaDisplay`),
    sessionBar: document.getElementById(`stall${i}SessionBar`),
    sessionProgressPct: document.getElementById(`stall${i}SessionProgressPct`),
    badge: document.getElementById(`stall${i}Badge`),
  }));

  function createStallState() {
    return {
      active: false,
      soc: 0,
      sessionStartSoc: 0,
      formSocTarget: 100,
      effectiveSocTarget: 100,
      sessionDeliveredKwh: 0,
      lastPowerKw: 0,
      etaSmoothedSec: null,
      /** 拔枪/离站/进站/插枪等综合等待（模拟秒，随倍速扣减） */
      cooldownRemainSim: 0,
    };
  }

  const stalls = [createStallState(), createStallState()];

  let rafId = null;
  let lastNow = 0;
  let cabinetRemainingKwh = 0;
  let paused = false;
  let completedCount = 0;
  let totalDeliveredKwh = 0;
  let sessionSimElapsedSec = 0;
  let cabinetDrainTimeSec = null;

  /** 功率/电压/电流/合计功率：按墙钟节流（倍速只加速仿真，不加速人眼看数字） */
  const POWER_UI_WALL_MS = 420;
  let lastPowerUiWallMs = 0;

  function getVehiclePreset() {
    const id = el.vehicleModel && el.vehicleModel.value;
    const p = (id && VEHICLE_PRESETS[id]) || VEHICLE_PRESETS['byd-han-ev'];
    return { id: id || 'byd-han-ev', ...p };
  }

  function readNumber(input, fallback) {
    const v = parseFloat(input.value);
    return Number.isFinite(v) ? v : fallback;
  }

  function readConfig() {
    const v = getVehiclePreset();
    const drainToEmpty = !!(el.drainToEmpty && el.drainToEmpty.checked);
    const gridChargeKw = Math.max(0, el.gridChargeKw ? readNumber(el.gridChargeKw, 0) : 0);
    const continuousNoGap = !drainToEmpty && gridChargeKw > EPS;
    return {
      rated: Math.max(1, readNumber(el.cabinetRated, 500)),
      eta: clamp(readNumber(el.cabinetEta, 1), 0.5, 1),
      note: v.name,
      cap: Math.max(1, v.cap),
      maxKw: Math.max(1, v.maxKw),
      socStart: clamp(readNumber(el.socStartInput, 20), 0, 99),
      socTarget: clamp(readNumber(el.socTargetInput, 100), 1, 100),
      speed: Math.max(1, parseInt(el.speed.value, 10) || 50),
      autoChain: el.autoChain.checked,
      stationMaxKw: Math.max(100, el.stationMaxKw ? readNumber(el.stationMaxKw, 1000) : 1000),
      /** 自动补能功率档位（kW，演示）；0 表示关闭自动补能、仅放电模型 */
      gridChargeKw,
      /** 榨干模式：仿真中不再把电网补能计入柜体（保证柜体可被放电耗尽） */
      drainToEmpty,
      /* 自动补能开启时忽略间隔，保证只要柜里还有能量就持续输出 */
      turnaroundSimSec: drainToEmpty ? 0 : (continuousNoGap ? 0 : Math.max(0, parseInt(el.turnaroundSimSec?.value ?? '0', 10) || 0)),
      stallBLagSimSec: drainToEmpty ? 0 : (continuousNoGap ? 0 : Math.max(0, parseInt(el.stallBLagSimSec?.value ?? '0', 10) || 0)),
    };
  }

  /** 无车充/无换车间隔等待时仍推进仿真，直至补满（演示） */
  function shouldRunGridRefill() {
    const c = readConfig();
    if (c.drainToEmpty) return false;
    return c.gridChargeKw > EPS && cabinetRemainingKwh < c.rated - EPS;
  }

  function clamp(x, a, b) {
    return Math.min(b, Math.max(a, x));
  }

  /** 功率展示：统一四舍五入到整数 kW（个位） */
  function formatStallPower(kw) {
    const r = Math.round(kw);
    return `${r} kW`;
  }

  /** 双枪合计：主显整数 kW；副行仅在 ≥1000 kW 时给整数 MW 参考 */
  function setTotalPowerDisplay(sumKw) {
    const r = Math.round(sumKw);
    if (r <= 0) {
      el.totalPowerDisplay.textContent = '0 kW';
      el.totalPowerMw.textContent = '';
      return;
    }
    el.totalPowerDisplay.textContent = `${r} kW`;
    el.totalPowerMw.textContent = r >= 1000 ? `（约 ${Math.round(r / 1000)} MW）` : '';
  }

  function anyActive() {
    return stalls[0].active || stalls[1].active;
  }

  function anyCooldownPending() {
    return stalls[0].cooldownRemainSim > EPS || stalls[1].cooldownRemainSim > EPS;
  }

  function processStallCooldowns(dt) {
    if (dt <= 0) return;
    for (let i = 0; i < 2; i++) {
      const st = stalls[i];
      if (st.active || st.cooldownRemainSim <= EPS) continue;
      st.cooldownRemainSim -= dt;
      if (st.cooldownRemainSim <= 0) {
        st.cooldownRemainSim = 0;
        tryStartStall(i);
      }
    }
  }

  function computeEffectiveTarget(soc0, target, capKwh, remainingCabKwh, eta) {
    const needKwh = capKwh * (target - soc0) / 100;
    const availToVehicleKwh = remainingCabKwh * eta;
    if (needKwh <= availToVehicleKwh + 1e-9) return target;
    return soc0 + (availToVehicleKwh / capKwh) * 100;
  }

  /**
   * 闪充高平台：低 SOC 长时间满倍率，接近满电再 taper（贴近兆瓦闪充「前期拉满」观感）
   */
  function powerTaper(s) {
    if (s <= 88) return 1;
    if (s >= 99) return 0.14;
    return 1 - ((s - 88) / 11) * 0.86;
  }

  function formatEta(sec) {
    if (sec === null || !Number.isFinite(sec) || sec === Infinity) return '—';
    if (sec < 60) return `${Math.round(sec)} 秒`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m} 分 ${s} 秒`;
  }

  function setInputsDisabled(disabled) {
    [
      el.cabinetRated,
      el.cabinetEta,
      el.gridChargeKw,
      el.stationMaxKw,
      el.vehicleModel,
      el.socStartInput,
      el.socTargetInput,
      el.autoChain,
      el.speed,
      el.turnaroundSimSec,
      el.stallBLagSimSec,
    ].forEach((node) => {
      if (node) node.disabled = disabled;
    });
  }

  function stopLoop() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  /** 尝试在给定车位启动一轮（从表单读车型与起止 SOC） */
  function tryStartStall(index) {
    const c = readConfig();
    if (c.socStart >= c.socTarget) return false;
    if (cabinetRemainingKwh <= EPS) return false;
    const st = stalls[index];
    if (st.active) return false;
    if (st.cooldownRemainSim > EPS) return false;
    st.formSocTarget = c.socTarget;
    st.sessionStartSoc = c.socStart;
    st.soc = c.socStart;
    st.sessionDeliveredKwh = 0;
    st.etaSmoothedSec = null;
    let eff = computeEffectiveTarget(st.soc, c.socTarget, c.cap, cabinetRemainingKwh, c.eta);
    eff = clamp(eff, st.soc, c.socTarget);
    st.effectiveSocTarget = eff;
    if (eff - st.soc < SOC_START_MIN_DELTA_PCT) return false;
    st.cooldownRemainSim = 0;
    st.active = true;
    return true;
  }

  /**
   * 结束该车位当前会话；非 abort 时计完成 1 台；自动接车时可先经换车间隔（模拟秒）再开下一轮。
   */
  function completeStall(index, reason) {
    const st = stalls[index];
    if (!st.active) return;
    st.active = false;
    st.lastPowerKw = 0;
    st.etaSmoothedSec = null;
    st.sessionDeliveredKwh = 0;
    if (reason !== 'abort') {
      completedCount += 1;
    }

    const cfg = readConfig();
    const chain =
      cfg.autoChain &&
      cabinetRemainingKwh > EPS &&
      reason !== 'abort' &&
      cfg.socStart < cfg.socTarget;
    if (chain) {
      const gap = cfg.turnaroundSimSec;
      if (gap > EPS) {
        stalls[index].cooldownRemainSim = gap;
      } else {
        tryStartStall(index);
      }
    }

    if (!anyActive()) {
      if (!anyCooldownPending()) {
        stopLoop();
        rafId = null;
        setInputsDisabled(false);
        el.btnAbortSession.disabled = true;
        if (reason !== 'abort') {
          stalls[0].sessionDeliveredKwh = 0;
          stalls[1].sessionDeliveredKwh = 0;
        }
      } else {
        if (rafId == null) {
          lastNow = performance.now();
          rafId = requestAnimationFrame(tick);
        }
        setInputsDisabled(false);
        el.btnAbortSession.disabled = true;
      }
    }

    render();
  }

  function tick(now) {
    if (paused) {
      lastNow = now;
      if (anyActive() || anyCooldownPending()) {
        rafId = requestAnimationFrame(tick);
      }
      render();
      return;
    }

    const c = readConfig();
    const dtReal = (now - lastNow) / 1000;
    lastNow = now;
    const dtRaw = dtReal * c.speed;
    const dtMaxSimSec = Math.min(120, 0.2 * c.speed + 0.4);
    const dt = clamp(dtRaw, 0, dtMaxSimSec);

    sessionSimElapsedSec += dt;
    processStallCooldowns(dt);
    /* 榨干模式下不再计入电网补能，保证柜体可被放电耗尽到 0 */
    const gridKIn = c.drainToEmpty ? 0 : (c.gridChargeKw * dt) / 3600;

    /* 无充电无换车间隔：仅自动补能，补满或功率为 0 则停表 */
    if (!anyActive() && !anyCooldownPending()) {
      if (gridKIn > EPS && cabinetRemainingKwh < c.rated - EPS) {
        cabinetRemainingKwh = clamp(cabinetRemainingKwh + gridKIn, 0, c.rated);
        rafId = requestAnimationFrame(tick);
        render();
        return;
      }
      stopLoop();
      rafId = null;
      setInputsDisabled(false);
      el.btnAbortSession.disabled = true;
      render();
      return;
    }

    /* 仅换车间隔等待：时间仍走，自动补能照常 */
    if (!anyActive() && anyCooldownPending()) {
      if (gridKIn > EPS && cabinetRemainingKwh < c.rated - EPS) {
        cabinetRemainingKwh = clamp(cabinetRemainingKwh + gridKIn, 0, c.rated);
      }
      rafId = requestAnimationFrame(tick);
      render();
      return;
    }

    /* 至少有一枪在充：本帧先计补能再算可放预算 */
    const sMid = clamp(cabinetRemainingKwh + gridKIn, 0, c.rated);
    if (sMid <= EPS) {
      cabinetRemainingKwh = 0;
      if (cabinetDrainTimeSec == null) cabinetDrainTimeSec = sessionSimElapsedSec;
      for (let i = 0; i < 2; i++) {
        if (stalls[i].active) completeStall(i, 'cabinet');
      }
      if (anyActive() || anyCooldownPending() || shouldRunGridRefill()) {
        rafId = requestAnimationFrame(tick);
      }
      render();
      return;
    }

    const pRaw = [0, 0];
    for (let i = 0; i < 2; i++) {
      if (!stalls[i].active) continue;
      const s = stalls[i];
      const mult = powerTaper(s.soc);
      const noise = 0.97 + Math.random() * 0.06;
      pRaw[i] = Math.max(mult * c.maxKw * noise, 0.4);
    }
    const sumPRaw = pRaw[0] + pRaw[1];
    const pStationScale = sumPRaw <= 1e-9 ? 0 : Math.min(1, c.stationMaxKw / sumPRaw);
    const pKwStall = [pRaw[0] * pStationScale, pRaw[1] * pStationScale];

    const ideals = [0, 0];
    for (let i = 0; i < 2; i++) {
      const s = stalls[i];
      if (!s.active) continue;
      let dEI = (pKwStall[i] * dt) / 3600;
      const kwhToT = (c.cap * (s.effectiveSocTarget - s.soc)) / 100;
      dEI = Math.min(dEI, Math.max(0, kwhToT));
      ideals[i] = dEI;
    }

    const sumI = ideals[0] + ideals[1];
    const budget = sMid * c.eta;
    const scale = sumI <= 1e-15 ? 0 : Math.min(1, budget / sumI);

    const dE = [0, 0];
    for (let i = 0; i < 2; i++) {
      if (!stalls[i].active) continue;
      const s = stalls[i];
      let de = ideals[i] * scale;
      const kwhToT = (c.cap * (s.effectiveSocTarget - s.soc)) / 100;
      de = Math.min(de, Math.max(0, kwhToT));
      dE[i] = de;
      s.lastPowerKw = de > 1e-12 ? de / (dt / 3600) : 0;
    }

    const totalDE = dE[0] + dE[1];
    if (totalDE <= 1e-15) {
      cabinetRemainingKwh = clamp(sMid, 0, c.rated);
      if (cabinetRemainingKwh <= EPS) {
        cabinetRemainingKwh = 0;
        for (let i = 0; i < 2; i++) {
          if (stalls[i].active) completeStall(i, 'cabinet');
        }
      }
      if (anyActive() || anyCooldownPending() || shouldRunGridRefill()) {
        rafId = requestAnimationFrame(tick);
      }
      render();
      return;
    }

    cabinetRemainingKwh = clamp(sMid - totalDE / c.eta, 0, c.rated);
    totalDeliveredKwh += totalDE;

    for (let i = 0; i < 2; i++) {
      const s = stalls[i];
      if (!s.active) continue;
      const de = dE[i];
      const dSoc = (de / c.cap) * 100;
      s.soc += dSoc;
      s.sessionDeliveredKwh += de;
      const remainKwh = (c.cap * (s.effectiveSocTarget - s.soc)) / 100;
      const instEta = s.lastPowerKw > 0.2 ? (remainKwh / s.lastPowerKw) * 3600 : Infinity;
      if (s.etaSmoothedSec == null) s.etaSmoothedSec = instEta;
      else s.etaSmoothedSec = s.etaSmoothedSec * 0.9 + instEta * 0.1;
    }

    const doneIdx = [];
    for (let i = 0; i < 2; i++) {
      const s = stalls[i];
      if (!s.active) continue;
      if (s.soc >= s.effectiveSocTarget - SOC_DONE_TOL_PCT) {
        s.soc = s.effectiveSocTarget;
        s.lastPowerKw = 0;
        doneIdx.push(i);
      }
    }
    doneIdx.forEach((i) => completeStall(i, 'target'));

    if (cabinetRemainingKwh <= EPS) {
      cabinetRemainingKwh = 0;
      if (cabinetDrainTimeSec == null) cabinetDrainTimeSec = sessionSimElapsedSec;
      for (let i = 0; i < 2; i++) {
        if (stalls[i].active) completeStall(i, 'cabinet');
      }
    }

    if (anyActive() || anyCooldownPending() || shouldRunGridRefill()) {
      rafId = requestAnimationFrame(tick);
    }
    render();
  }

  function render() {
    const cfg = readConfig();
    const rated = cfg.rated;
    cabinetRemainingKwh = clamp(cabinetRemainingKwh, 0, rated);

    el.cabinetRemaining.textContent = cabinetRemainingKwh.toFixed(2);
    const pct = rated > 0 ? (cabinetRemainingKwh / rated) * 100 : 0;
    el.cabinetPercent.textContent = pct.toFixed(1);
    el.cabinetBar.style.width = `${clamp(pct, 0, 100)}%`;
    el.cabinetBar.parentElement.setAttribute('aria-valuenow', String(Math.round(pct)));

    if (el.cabinetDrainTimeDisplay) {
      const simRunning = rafId != null;
      const showSec = cabinetDrainTimeSec == null ? (simRunning ? sessionSimElapsedSec : null) : cabinetDrainTimeSec;
      el.cabinetDrainTimeDisplay.textContent = showSec == null ? '—' : formatEta(showSec);
    }

    el.completedCount.textContent = String(completedCount);
    el.totalDelivered.textContent = totalDeliveredKwh.toFixed(2);
    el.sessionDeliveredA.textContent = stalls[0].sessionDeliveredKwh.toFixed(2);
    el.sessionDeliveredB.textContent = stalls[1].sessionDeliveredKwh.toFixed(2);
    el.sessionDeliveredSum.textContent = (stalls[0].sessionDeliveredKwh + stalls[1].sessionDeliveredKwh).toFixed(2);

    const wallNow = performance.now();
    const simBusy = anyActive();
    let refreshPowerUi = !simBusy;
    if (simBusy) {
      if (wallNow - lastPowerUiWallMs >= POWER_UI_WALL_MS) {
        refreshPowerUi = true;
        lastPowerUiWallMs = wallNow;
      }
    } else {
      lastPowerUiWallMs = 0;
    }

    let sumP = 0;
    for (let i = 0; i < 2; i++) {
      const s = stalls[i];
      const ui = stallUi[i];
      sumP += s.active ? s.lastPowerKw : 0;

      if (s.active) {
        ui.socDisplay.textContent = s.soc.toFixed(1);
        ui.socRing.style.strokeDasharray = `${RING_C}`;
        ui.socRing.style.strokeDashoffset = `${RING_C * (1 - clamp(s.soc, 0, 100) / 100)}`;
        if (refreshPowerUi) {
          ui.powerDisplay.textContent = formatStallPower(s.lastPowerKw);
          const uBase = 650 + (s.soc / 100) * 90;
          const volt = Math.round(uBase);
          const amp = s.lastPowerKw > 0.05 ? (s.lastPowerKw * 1000) / volt : 0;
          ui.voltDisplay.textContent = volt.toFixed(0);
          ui.ampDisplay.textContent = amp.toFixed(0);
        }
        /* 预计剩余跟仿真走，每帧更新 */
        ui.etaDisplay.textContent = formatEta(s.etaSmoothedSec);
        const span = Math.max(0.001, s.effectiveSocTarget - s.sessionStartSoc);
        const sProg = clamp((s.soc - s.sessionStartSoc) / span, 0, 1) * 100;
        ui.sessionBar.style.width = `${sProg}%`;
        ui.sessionProgressPct.textContent = sProg.toFixed(1);
        ui.badge.textContent = paused ? '已暂停' : '充电中';
      } else if (s.cooldownRemainSim > EPS) {
        ui.socDisplay.textContent = '—';
        ui.socRing.style.strokeDasharray = `${RING_C}`;
        ui.socRing.style.strokeDashoffset = `${RING_C}`;
        ui.powerDisplay.textContent = '0 kW';
        ui.voltDisplay.textContent = '—';
        ui.ampDisplay.textContent = '—';
        ui.etaDisplay.textContent = '—';
        ui.sessionBar.style.width = '0%';
        ui.sessionProgressPct.textContent = '0';
        ui.badge.textContent = `换车间 · 余 ${Math.max(0, Math.ceil(s.cooldownRemainSim))}s（模拟）`;
      } else {
        ui.socDisplay.textContent = '—';
        ui.socRing.style.strokeDasharray = `${RING_C}`;
        ui.socRing.style.strokeDashoffset = `${RING_C}`;
        ui.powerDisplay.textContent = '0 kW';
        ui.voltDisplay.textContent = '—';
        ui.ampDisplay.textContent = '—';
        ui.etaDisplay.textContent = '—';
        ui.sessionBar.style.width = '0%';
        ui.sessionProgressPct.textContent = '0';
        ui.badge.textContent = '空闲';
      }
    }
    if (refreshPowerUi) {
      setTotalPowerDisplay(sumP);
    }

    el.vehicleNoteDisplay.textContent = cfg.note;
    el.vehicleSpecLine.textContent = `本车：${cfg.note} · 标称电量约 ${cfg.cap} kWh · 车端峰值直流约 ${cfg.maxKw} kW（闪充模型输入）`;

    const hintForm = cfg.socTarget;
    const hintEffective = clamp(
      computeEffectiveTarget(cfg.socStart, cfg.socTarget, cfg.cap, cabinetRemainingKwh, cfg.eta),
      cfg.socStart,
      cfg.socTarget
    );
    const truncHint =
      hintEffective < hintForm - 0.05
        ? `（柜体限制，预览截断至 ${hintEffective.toFixed(1)}%）`
        : '';
    el.effectiveTargetHint.textContent = anyActive()
      ? `两车并行中；表单目标 ${hintForm.toFixed(1)}%（各车位独立按截断目标充电）`
      : `下一批双枪：两车均从 ${cfg.socStart}% → 目标 ${hintForm.toFixed(1)}%，有效目标约 ${hintEffective.toFixed(1)}%${truncHint}`;

    const cabinetEmpty = cabinetRemainingKwh <= EPS;
    const bothBusy = stalls[0].active && stalls[1].active;
    const formOk = cfg.socStart < cfg.socTarget;

    const canGridOnly =
      cabinetEmpty &&
      cfg.gridChargeKw > EPS &&
      !cfg.drainToEmpty &&
      !anyActive() &&
      !anyCooldownPending() &&
      formOk;
    el.btnStart.disabled =
      anyActive() || anyCooldownPending() || (!canGridOnly && cabinetEmpty) || !formOk;
    el.btnPause.disabled = !anyActive();
    el.btnPause.textContent = paused ? '继续' : '暂停';
    el.btnNext.disabled = cabinetEmpty || !formOk || bothBusy;

    el.btnAbortSession.disabled = !anyActive();

    el.btnCabinetFull.disabled = anyActive() || anyCooldownPending();
    el.btnClearStats.disabled = anyActive() || anyCooldownPending();
    el.btnResetAll.disabled = anyActive() || anyCooldownPending();

    if (
      cfg.gridChargeKw > EPS &&
      !cfg.drainToEmpty &&
      cabinetRemainingKwh < cfg.rated - EPS &&
      !anyActive() &&
      !anyCooldownPending() &&
      !paused &&
      rafId != null
    ) {
      el.cabinetStatus.textContent = '自动补能中（演示）';
    } else if (cabinetEmpty && !anyActive() && !anyCooldownPending()) {
      el.cabinetStatus.textContent = '站端储电柜已耗尽（演示）';
    } else if (anyActive()) {
      el.cabinetStatus.textContent = paused ? '闪充已暂停（双枪）' : '比亚迪闪充进行中（双枪）';
    } else if (anyCooldownPending()) {
      el.cabinetStatus.textContent = '换车间隔 / 车位就绪等待中（模拟时间）';
    } else {
      el.cabinetStatus.textContent = '待命 · 可开始闪充';
    }
  }

  function validateForm() {
    const c = readConfig();
    if (c.socStart >= c.socTarget) {
      el.cabinetStatus.textContent = '请保证起始 SOC 小于目标 SOC';
      return false;
    }
    return true;
  }

  function onStart() {
    if (anyActive() || anyCooldownPending()) return;
    if (!validateForm()) {
      render();
      return;
    }
    // 开始计时：从按下「开始闪充」起，到储电柜首次耗尽（0 kWh）
    sessionSimElapsedSec = 0;
    cabinetDrainTimeSec = null;
    if (el.cabinetDrainTimeDisplay) el.cabinetDrainTimeDisplay.textContent = '—';
    const cfg = readConfig();
    /* 柜空且开启自动补能：先只跑补能循环，待有余量后再点开始闪充 */
    if (cabinetRemainingKwh <= EPS && cfg.gridChargeKw > EPS && !cfg.drainToEmpty) {
      paused = false;
      lastNow = performance.now();
      stopLoop();
      rafId = requestAnimationFrame(tick);
      render();
      return;
    }
    /* 柜空且关闭自动补能：恢复满柜便于快速演示 */
    if (cabinetRemainingKwh <= EPS && cfg.gridChargeKw <= EPS) {
      cabinetRemainingKwh = cfg.rated;
    }
    const a = tryStartStall(0);
    const lag = cfg.stallBLagSimSec;
    let bScheduled = false;
    if (lag > EPS) {
      stalls[1].cooldownRemainSim = lag;
      bScheduled = true;
    } else {
      bScheduled = tryStartStall(1);
    }
    if (!a && !bScheduled) {
      el.cabinetStatus.textContent = '柜内余量不足或参数无效，无法启动车位';
      render();
      return;
    }
    paused = false;
    setInputsDisabled(true);
    el.btnAbortSession.disabled = false;
    lastNow = performance.now();
    stopLoop();
    rafId = requestAnimationFrame(tick);
    render();
  }

  function onPause() {
    if (!anyActive()) return;
    paused = !paused;
    render();
  }

  function onNext() {
    if (!validateForm()) return;
    const cfg = readConfig();
    if (cabinetRemainingKwh <= EPS) {
      el.cabinetStatus.textContent = '储电柜已空';
      render();
      return;
    }
    let started = false;
    if (!stalls[0].active) {
      stalls[0].cooldownRemainSim = 0;
      started = tryStartStall(0) || started;
    }
    if (!stalls[1].active) {
      stalls[1].cooldownRemainSim = 0;
      started = tryStartStall(1) || started;
    }
    if (!started) {
      el.cabinetStatus.textContent = '无空闲车位或无法启动';
      render();
      return;
    }
    paused = false;
    setInputsDisabled(true);
    el.btnAbortSession.disabled = false;
    if (rafId == null) {
      lastNow = performance.now();
      rafId = requestAnimationFrame(tick);
    }
    render();
  }

  function onAbortSession() {
    if (!anyActive()) return;
    const cfg = readConfig();
    stopLoop();
    rafId = null;
    sessionSimElapsedSec = 0;
    cabinetDrainTimeSec = null;
    if (el.cabinetDrainTimeDisplay) el.cabinetDrainTimeDisplay.textContent = '—';
    let restore = 0;
    for (let i = 0; i < 2; i++) {
      const s = stalls[i];
      if (!s.active) continue;
      restore += s.sessionDeliveredKwh / cfg.eta;
      totalDeliveredKwh -= s.sessionDeliveredKwh;
      s.sessionDeliveredKwh = 0;
      s.soc = s.sessionStartSoc;
      s.active = false;
      s.lastPowerKw = 0;
      s.etaSmoothedSec = null;
      s.cooldownRemainSim = 0;
    }
    if (totalDeliveredKwh < 0) totalDeliveredKwh = 0;
    cabinetRemainingKwh += restore;
    cabinetRemainingKwh = clamp(cabinetRemainingKwh, 0, cfg.rated);
    paused = false;
    setInputsDisabled(false);
    el.btnAbortSession.disabled = true;
    render();
  }

  function onCabinetFull() {
    if (anyActive() || anyCooldownPending()) return;
    const c = readConfig();
    const opt = el.cabinetRated.querySelector(`option[value="${c.rated}"]`);
    if (opt) el.cabinetRated.value = String(c.rated);
    cabinetRemainingKwh = c.rated;
    render();
  }

  function onClearStats() {
    if (anyActive() || anyCooldownPending()) return;
    completedCount = 0;
    totalDeliveredKwh = 0;
    sessionSimElapsedSec = 0;
    cabinetDrainTimeSec = null;
    if (el.cabinetDrainTimeDisplay) el.cabinetDrainTimeDisplay.textContent = '—';
    render();
  }

  function onResetAll() {
    if (anyActive() || anyCooldownPending()) return;
    const c = readConfig();
    cabinetRemainingKwh = c.rated;
    completedCount = 0;
    totalDeliveredKwh = 0;
    sessionSimElapsedSec = 0;
    cabinetDrainTimeSec = null;
    if (el.cabinetDrainTimeDisplay) el.cabinetDrainTimeDisplay.textContent = '—';
    stalls[0] = createStallState();
    stalls[1] = createStallState();
    paused = false;
    setInputsDisabled(false);
    el.btnAbortSession.disabled = true;
    render();
  }

  el.btnStart.addEventListener('click', onStart);
  el.btnPause.addEventListener('click', onPause);
  el.btnNext.addEventListener('click', onNext);
  el.btnCabinetFull.addEventListener('click', onCabinetFull);
  el.btnClearStats.addEventListener('click', onClearStats);
  el.btnAbortSession.addEventListener('click', onAbortSession);
  el.btnResetAll.addEventListener('click', onResetAll);

  function bindFormRefresh(node) {
    if (!node) return;
    node.addEventListener('input', () => render());
    node.addEventListener('change', () => render());
  }

  [el.cabinetRated, el.cabinetEta, el.gridChargeKw, el.stationMaxKw].forEach(bindFormRefresh);
  [
    el.vehicleModel,
    el.socStartInput,
    el.socTargetInput,
    el.autoChain,
    el.speed,
    el.turnaroundSimSec,
    el.stallBLagSimSec,
  ].forEach(bindFormRefresh);

  cabinetRemainingKwh = readConfig().rated;
  render();
})();
