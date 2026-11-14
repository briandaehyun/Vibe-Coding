/**
 * RISC 5-Stage Pipeline Execution Visualizer (Hamacher Chapter 6: Pipelining)
 * Supports:
 * - Data Dependency (RAW Hazards) & Operand Forwarding from RZ (B3) and RY (B4)
 * - Memory Delays: Data Cache Miss in M stage (Fig. 6.7), Load-Use Hazard (Fig. 6.8), Unified Cache Structural Hazard (Sec. 6.7)
 * - Branch Delays: Compute-stage vs Decode-stage (Second Adder) resolution (Fig. 6.9, 6.10), Static & Dynamic Prediction (2-State & 4-State BTB, Fig. 6.12)
 */

const PRESETS = {
  fig6_3: {
    name: 'Fig 6.3 / 6.4: Data Dependency & Forwarding',
    code: `Add R2, R3, #100\nSubtract R9, R2, #30`,
    settings: {
      fwdRZ: false,
      fwdRY: false,
      secondAdder: false,
      staticPred: false,
      dynamicPred: false,
      memMissCycles: 0,
      unifiedCache: false,
      branchOutcome: 'loop_taken',
      loopIters: 2
    }
  },
  fig6_15: {
    name: 'Fig 6.15 (Example 6.1): RZ & RY Forwarding',
    code: `Add R4, R3, R2\nOr R7, R6, R5\nSubtract R8, R7, R4`,
    settings: {
      fwdRZ: true,
      fwdRY: true,
      secondAdder: false,
      staticPred: false,
      dynamicPred: false,
      memMissCycles: 0,
      unifiedCache: false,
      branchOutcome: 'loop_taken',
      loopIters: 2
    }
  },
  fig6_8: {
    name: 'Fig 6.8: Load-Use Data Dependency Delay',
    code: `Load R2, (R3)\nSubtract R9, R2, #30`,
    settings: {
      fwdRZ: true,
      fwdRY: true,
      secondAdder: false,
      staticPred: false,
      dynamicPred: false,
      memMissCycles: 0,
      unifiedCache: false,
      branchOutcome: 'loop_taken',
      loopIters: 2
    }
  },
  fig6_7: {
    name: 'Fig 6.7: Memory Access Delay (Cache Miss)',
    code: `Load R2, (R3) [miss=2]\nAdd R4, R5, R6\nSubtract R7, R8, R9`,
    settings: {
      fwdRZ: true,
      fwdRY: true,
      secondAdder: false,
      staticPred: false,
      dynamicPred: false,
      memMissCycles: 0,
      unifiedCache: false,
      branchOutcome: 'loop_taken',
      loopIters: 2
    }
  },
  fig6_9: {
    name: 'Fig 6.9 & 6.10: Unconditional Branch Penalty',
    code: `Branch TARGET\nAdd R1, R2, R3\nSubtract R4, R5, R6\nTARGET: Or R7, R8, R9`,
    settings: {
      fwdRZ: false,
      fwdRY: false,
      secondAdder: false,
      staticPred: false,
      dynamicPred: false,
      memMissCycles: 0,
      unifiedCache: false,
      branchOutcome: 'always_taken',
      loopIters: 1
    }
  },
  loop_branch: {
    name: 'Sec 6.6.4: Conditional Branch Loop & Prediction',
    code: `LOOP: Add R2, R2, #1\nSubtract R3, R3, #1\nBranch_if_[R3]>0 LOOP\nMove R5, R2`,
    settings: {
      fwdRZ: true,
      fwdRY: true,
      secondAdder: true,
      staticPred: false,
      dynamicPred: false,
      memMissCycles: 0,
      unifiedCache: false,
      branchOutcome: 'loop_taken',
      loopIters: 2
    }
  },
  prob6_12: {
    name: 'Problem 6.12: 연속 레지스터 덮어쓰기 & Forwarding',
    code: `Add R3, R2, R1\nSubtract R3, R5, R4\nOr R8, R3, #1`,
    settings: {
      fwdRZ: false,
      fwdRY: false,
      secondAdder: false,
      staticPred: false,
      dynamicPred: false,
      memMissCycles: 0,
      unifiedCache: false,
      branchOutcome: 'loop_taken',
      loopIters: 2
    }
  }
};

// Per-instruction interactive cache miss overrides (by line index)
const lineMissOverrides = new Map();

/**
 * Parse RISC Assembly Text into structured instruction objects
 */
function parseProgram(rawText) {
  const lines = rawText.split(/\r?\n/);
  const instructions = [];
  const labelMap = new Map();
  let pendingLabel = null;

  lines.forEach((rawLine, lineIdx) => {
    // Strip comments starting with ; or //
    let line = rawLine.replace(/(\/\/|;).*$/, '').trim();
    if (!line) return;

    // Check inline [miss=N] tag
    let inlineMiss = null;
    const missMatch = line.match(/\[\s*miss\s*=\s*(\d+)\s*\]/i);
    if (missMatch) {
      inlineMiss = parseInt(missMatch[1], 10);
      line = line.replace(missMatch[0], '').trim();
    }

    // Optional leading memory address like "1000 Add R3, R2, #20"
    let address = null;
    const addrMatch = line.match(/^(\d{3,6}|0x[0-9a-fA-F]+)\s+(.*)$/);
    if (addrMatch) {
      address = addrMatch[1];
      line = addrMatch[2].trim();
    }

    // Optional label like "LOOP: Add ..." or standalone "TARGET:"
    const labelMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (labelMatch) {
      pendingLabel = labelMatch[1].toUpperCase();
      line = labelMatch[2].trim();
      if (!line) {
        labelMap.set(pendingLabel, instructions.length);
        return;
      }
    }

    const instrIndex = instructions.length;
    if (pendingLabel) {
      labelMap.set(pendingLabel, instrIndex);
    }

    const parsed = parseSingleInstruction(line, instrIndex, lineIdx, pendingLabel, address, inlineMiss);
    instructions.push(parsed);
    pendingLabel = null;
  });

  return { instructions, labelMap };
}

/**
 * Extract register names like R0..R31 from operand token
 */
function extractRegisters(token) {
  if (!token) return [];
  const matches = token.match(/\bR\d+\b/gi);
  return matches ? matches.map(r => r.toUpperCase()) : [];
}

function parseSingleInstruction(line, index, sourceLineIdx, label, address, inlineMiss) {
  const displayText = label ? `${label}: ${line}` : line;
  const tokens = line.trim().split(/\s+/);
  const opcodeRaw = tokens[0] || 'NOP';
  const opcodeUpper = opcodeRaw.toUpperCase();
  const rest = line.trim().slice(opcodeRaw.length).trim();

  let type = 'ALU'; // ALU | LOAD | STORE | BRANCH_UNCOND | BRANCH_COND | NOP
  let destReg = null;
  let srcRegs = [];
  let targetLabel = null;
  let sideEffectReg = null; // e.g. (R8)+ autoincrement in Sec 6.10

  if (opcodeUpper === 'NOP') {
    type = 'NOP';
  } else if (opcodeUpper === 'LOAD' || opcodeUpper === 'LW' || opcodeUpper === 'LD') {
    type = 'LOAD';
    const parts = rest.split(',').map(s => s.trim());
    if (parts[0]) {
      const d = extractRegisters(parts[0]);
      if (d.length > 0) destReg = d[0];
    }
    if (parts[1]) {
      srcRegs = extractRegisters(parts[1]);
    }
  } else if (opcodeUpper === 'STORE' || opcodeUpper === 'SW' || opcodeUpper === 'ST') {
    type = 'STORE';
    const parts = rest.split(',').map(s => s.trim());
    parts.forEach(p => {
      srcRegs.push(...extractRegisters(p));
    });
  } else if (
    opcodeUpper === 'BRANCH' ||
    opcodeUpper === 'BR' ||
    opcodeUpper === 'JMP' ||
    opcodeUpper === 'JUMP' ||
    opcodeUpper === 'J' ||
    opcodeUpper === 'CALL'
  ) {
    type = 'BRANCH_UNCOND';
    // Handle "Branch to Ik" or "Branch TARGET"
    const cleanedTarget = rest.replace(/^to\s+/i, '').trim();
    targetLabel = cleanedTarget.split(/[\s,]+/)[0]?.toUpperCase() || 'TARGET';
    if (opcodeUpper === 'CALL') {
      destReg = 'RA_LINK';
    }
  } else if (
    opcodeUpper.startsWith('BRANCH_IF') ||
    opcodeUpper.startsWith('BRANCH>') ||
    opcodeUpper.startsWith('BRANCH<') ||
    opcodeUpper.startsWith('BRANCH=') ||
    opcodeUpper === 'BEQ' ||
    opcodeUpper === 'BNE' ||
    opcodeUpper === 'BGT' ||
    opcodeUpper === 'BLT' ||
    opcodeUpper === 'BGE' ||
    opcodeUpper === 'BLE' ||
    opcodeUpper === 'BGTZ' ||
    opcodeUpper === 'BNEZ' ||
    opcodeUpper === 'BEQZ'
  ) {
    type = 'BRANCH_COND';
    // Extract any registers inside opcode like Branch_if_[R5]=[R6]
    srcRegs.push(...extractRegisters(opcodeRaw));
    if (opcodeUpper === 'BEQ' || opcodeUpper === 'BNE' || opcodeUpper === 'BGT' || opcodeUpper === 'BLT' || opcodeUpper === 'BGE' || opcodeUpper === 'BLE') {
      const parts = rest.split(',').map(s => s.trim());
      if (parts.length >= 3) {
        srcRegs.push(...extractRegisters(parts[0]), ...extractRegisters(parts[1]));
        targetLabel = parts[2].toUpperCase();
      } else if (parts.length === 2) {
        srcRegs.push(...extractRegisters(parts[0]));
        targetLabel = parts[1].toUpperCase();
      } else {
        targetLabel = rest.toUpperCase();
      }
    } else {
      srcRegs.push(...extractRegisters(rest));
      const parts = rest.split(/[\s,]+/).filter(Boolean);
      targetLabel = parts[parts.length - 1]?.toUpperCase() || 'TARGET';
    }
  } else if (opcodeUpper === 'COMPARE' || opcodeUpper === 'CMP') {
    type = 'ALU';
    destReg = 'CC_FLAGS';
    const parts = rest.split(',').map(s => s.trim());
    parts.forEach(p => srcRegs.push(...extractRegisters(p)));
  } else if (opcodeUpper === 'MOVE' || opcodeUpper === 'MOV') {
    const parts = rest.split(',').map(s => s.trim());
    // Check if memory addressing is used in Move (e.g. Move R5, (R8)+)
    if (parts[0] && parts[0].includes('(')) {
      type = 'STORE';
      parts.forEach(p => srcRegs.push(...extractRegisters(p)));
    } else if (parts[1] && parts[1].includes('(')) {
      type = 'LOAD';
      const d = extractRegisters(parts[0]);
      if (d.length > 0) destReg = d[0];
      srcRegs.push(...extractRegisters(parts[1]));
      if (parts[1].includes(')+') || parts[1].includes('-(')) {
        const s = extractRegisters(parts[1]);
        if (s.length > 0) sideEffectReg = s[0];
      }
    } else {
      type = 'ALU';
      const d = extractRegisters(parts[0]);
      if (d.length > 0) destReg = d[0];
      if (parts[1]) srcRegs.push(...extractRegisters(parts[1]));
    }
  } else {
    // Standard 3-operand or 2-operand ALU instruction: Add Rd, Rs1, Rs2 / #imm
    type = 'ALU';
    const parts = rest.split(',').map(s => s.trim());
    if (parts.length > 0) {
      const d = extractRegisters(parts[0]);
      if (d.length > 0) destReg = d[0];
      for (let i = 1; i < parts.length; i++) {
        srcRegs.push(...extractRegisters(parts[i]));
      }
    }
  }

  // Deduplicate srcRegs
  srcRegs = [...new Set(srcRegs)];

  return {
    index,
    sourceLineIdx,
    label,
    address,
    rawText: line.trim(),
    displayText,
    opcode: opcodeRaw,
    type,
    destReg,
    sideEffectReg,
    srcRegs,
    targetLabel,
    inlineMiss
  };
}

/**
 * Core Cycle-Accurate 5-Stage Pipeline Simulator (Hamacher Chapter 6)
 */
function simulatePipeline(program, options) {
  const { instructions, labelMap } = program;
  if (instructions.length === 0) {
    return {
      rows: [],
      totalCycles: 0,
      forwardings: [],
      branchPenalties: [],
      hazardLogs: [],
      btbHistory: [],
      finalBtbState: options.dynInitState || 'LNT',
      stats: { dataDelay: 0, memDelay: 0, branchDelay: 0, totalDelay: 0 }
    };
  }

  // If a branch references a label (like "Ik" or "TARGET") that doesn't exist in labelMap,
  // check if the last instruction can act as the target or synthesize a virtual target instruction Ik
  const workingInstrs = instructions.map(inst => ({ ...inst }));
  const workingLabels = new Map(labelMap);

  workingInstrs.forEach((inst, idx) => {
    if ((inst.type === 'BRANCH_UNCOND' || inst.type === 'BRANCH_COND') && inst.targetLabel) {
      if (!workingLabels.has(inst.targetLabel)) {
        // If there are instructions at the end, or if the user wrote "Branch to Ik", synthesize Ik if needed
        const synthIdx = workingInstrs.length;
        workingLabels.set(inst.targetLabel, synthIdx);
        workingInstrs.push({
          index: synthIdx,
          sourceLineIdx: -1,
          label: inst.targetLabel,
          address: null,
          rawText: `${inst.targetLabel}`,
          displayText: `${inst.targetLabel}`,
          opcode: 'NOP',
          type: 'ALU',
          destReg: null,
          sideEffectReg: null,
          srcRegs: [],
          targetLabel: null,
          inlineMiss: null,
          isSynthesizedTarget: true
        });
      }
    }
  });

  // Dynamic Branch Predictor BTB state per instruction index
  const btbStateMap = new Map();
  const btbHistory = [];
  let lastBtbState = options.dynInitState || 'LNT';

  function getBtbState(pc) {
    if (!btbStateMap.has(pc)) {
      btbStateMap.set(pc, options.dynInitState || 'LNT');
    }
    return btbStateMap.get(pc);
  }

  function predictFromState(state) {
    return state === 'LT' || state === 'ST';
  }

  function updateBtbState(pc, actualTaken) {
    const prev = getBtbState(pc);
    let next = prev;
    if (options.dynBits === '2state') {
      // Fig 6.12a: 2-state machine (LNT <-> LT)
      next = actualTaken ? 'LT' : 'LNT';
    } else {
      // Fig 6.12b: 4-state machine (Hamacher page 207-208)
      // SNT <-> LNT, ST <-> LT; from LNT on BT -> ST; from LT on BNT -> SNT
      if (prev === 'SNT') next = actualTaken ? 'LNT' : 'SNT';
      else if (prev === 'LNT') next = actualTaken ? 'ST' : 'SNT';
      else if (prev === 'LT') next = actualTaken ? 'ST' : 'SNT';
      else if (prev === 'ST') next = actualTaken ? 'ST' : 'LT';
    }
    btbStateMap.set(pc, next);
    lastBtbState = next;
    return { prev, next };
  }

  // Track loop execution counts per branch PC
  const branchExecCount = new Map();
  const rows = [];
  const forwardings = [];
  const branchPenalties = [];
  const hazardLogs = [];
  let dataDelayTotal = 0;
  let memDelayTotal = 0;
  let branchDelayTotal = 0;

  // Build dynamic execution stream (handling branches, wrong-path fetches, and flushes)
  let pc = 0;
  let currentFetchCycle = 1;
  let maxRowLimit = 28;
  let rowIdCounter = 0;

  while (pc >= 0 && pc < workingInstrs.length && rows.length < maxRowLimit) {
    const inst = workingInstrs[pc];
    const execCount = (branchExecCount.get(pc) || 0) + 1;
    if (inst.type === 'BRANCH_UNCOND' || inst.type === 'BRANCH_COND') {
      branchExecCount.set(pc, execCount);
    }

    const row = scheduleInstructionRow(inst, execCount, currentFetchCycle, false);
    rows.push(row);

    // Check if this instruction is a branch
    if (inst.type === 'BRANCH_UNCOND' || inst.type === 'BRANCH_COND') {
      const targetPc = workingLabels.has(inst.targetLabel)
        ? workingLabels.get(inst.targetLabel)
        : pc + 1;
      const isBackward = targetPc <= pc;

      // Determine actual branch outcome
      let actualTaken = true;
      if (inst.type === 'BRANCH_UNCOND') {
        actualTaken = true;
      } else {
        if (options.branchOutcome === 'always_taken') {
          actualTaken = true;
        } else if (options.branchOutcome === 'always_not_taken') {
          actualTaken = false;
        } else {
          // loop_taken mode: if backward loop, taken for (loopIters - 1) times, then not-taken on last pass
          if (isBackward) {
            actualTaken = execCount < options.loopIters;
          } else {
            actualTaken = true;
          }
        }
      }

      // Determine prediction in F stage (cycle 1 of branch)
      let predictedTaken = false;
      let predictionModeLabel = '예측 미사용 (순차 인출)';
      let btbStateBefore = getBtbState(pc);

      if (options.dynamicPred) {
        predictedTaken = predictFromState(btbStateBefore);
        predictionModeLabel = `Dynamic Prediction (${options.dynBits === '2state' ? '2-State' : '4-State'}, 상태=${btbStateBefore} → ${predictedTaken ? 'Taken' : 'Not-Taken'} 예측)`;
      } else if (options.staticPred) {
        if (options.staticMode === 'always_taken') {
          predictedTaken = true;
          predictionModeLabel = 'Static Prediction (Assume Taken)';
        } else if (options.staticMode === 'not_taken') {
          predictedTaken = false;
          predictionModeLabel = 'Static Prediction (Assume Not-Taken)';
        } else {
          // backward_taken / characteristic-based static prediction
          predictedTaken = true;
          predictionModeLabel = isBackward
            ? 'Static Prediction (역방향 루프 분기 → Taken 예측)'
            : 'Static Prediction (컴파일러 분기 힌트 → Taken 예측)';
        }
      } else {
        predictedTaken = false;
        predictionModeLabel = '분기 예측 미사용 (기본 순차 PC+4 인출)';
      }

      // When is the branch target & condition resolved?
      // With Second Adder (& Comparator) in Decode: at end of D stage (row.dEnd)
      // Without Second Adder: at end of C stage (row.cEnd)
      const resolveStage = options.secondAdder ? 'D' : 'C';
      const resolveCycle = options.secondAdder ? row.dEnd : row.cEnd;

      // Update Dynamic BTB state
      let btbTransition = null;
      if (options.dynamicPred) {
        btbTransition = updateBtbState(pc, actualTaken);
        btbHistory.push({
          pass: btbHistory.length + 1,
          instrText: inst.rawText,
          cycle: resolveCycle,
          stateBefore: btbTransition.prev,
          predicted: predictedTaken ? 'Taken (BT)' : 'Not-Taken (BNT)',
          actual: actualTaken ? 'Taken (BT)' : 'Not-Taken (BNT)',
          hit: predictedTaken === actualTaken,
          stateAfter: btbTransition.next
        });
      }

      const isPredictionHit = (options.dynamicPred || options.staticPred) && (predictedTaken === actualTaken);
      const isNotTakenNoPenalty = !actualTaken && !predictedTaken;

      if (isPredictionHit || isNotTakenNoPenalty) {
        // 0 cycle branch penalty!
        const nextRightPc = actualTaken ? targetPc : pc + 1;
        currentFetchCycle = row.fEnd + 1;
        pc = nextRightPc;

        hazardLogs.push({
          type: 'resolved',
          title: `[Branch Penalty 0 Cycle] ${inst.rawText}`,
          cycles: `Cycle ${row.fStart}~${resolveCycle}`,
          detail: isPredictionHit
            ? `${predictionModeLabel}이 실제 분기 결과(${actualTaken ? 'Taken' : 'Not-Taken'})와 일치하여 잘못 인출된 명령어 없이 Cycle ${row.fEnd + 1}에 즉시 다음 명령어를 인출했습니다 (Branch Penalty = 0).`
            : `분기가 발생하지 않아(Not-Taken) 순차적으로 인출된 다음 명령어가 그대로 실행됩니다 (Branch Penalty = 0).`
        });
      } else {
        // Misprediction or Taken branch without prediction -> Wrong-path instructions are fetched and then discarded!
        // Fig 6.10 (Second Adder in Decode):
        // - 1 wrong instruction (Ij+1) is fetched while Branch is in D (fStart = row.dStart, fEnd = row.dEnd).
        // - If Branch stalled in D waiting for its condition register (e.g. R3), Ij+1 is held in F during that same D period (row.dStart..row.dEnd)
        //   and flushed right after F (reachedD = false), so its D slot is at (row.dEnd + 1).
        // - The next target instruction Ik starts F at (row.dEnd + 1) — directly at the discarded instruction's D column (1-cycle branch penalty)!
        // Fig 6.9 (No Second Adder, resolved in Compute):
        // - 2 wrong instructions fetched (Ij+1 has F in row.dStart..row.dEnd and D in row.cStart..row.cEnd; Ij+2 has F in row.cStart..row.cEnd),
        // - Next instruction Ik starts F at (row.cEnd + 1) (2-cycle branch penalty).
        const numWrongFetches = options.secondAdder ? 1 : 2;
        const penaltyCycles = options.secondAdder ? 1 : 2;
        const wrongBasePc = predictedTaken ? targetPc : pc + 1;
        const penaltyStartCycle = options.secondAdder ? row.dEnd : row.dEnd;

        for (let w = 0; w < numWrongFetches; w++) {
          const wPc = wrongBasePc + w;
          const wInst = workingInstrs[wPc] || {
            index: wPc,
            sourceLineIdx: -1,
            label: null,
            rawText: `I_j+${w + 1}`,
            displayText: `I_j+${w + 1}`,
            opcode: 'NOP',
            type: 'ALU',
            destReg: null,
            srcRegs: []
          };

          const wFStart = options.secondAdder
            ? row.dStart
            : (w === 0 ? row.dStart : row.cStart);
          const wFEnd = options.secondAdder
            ? row.dEnd
            : (w === 0 ? row.dEnd : row.cEnd);
          const reachedD = !options.secondAdder && w === 0;
          const wDStart = reachedD ? row.cStart : wFEnd + 1;
          const wDEnd = reachedD ? row.cEnd : wFEnd + 1;

          const flushedRow = scheduleFlushedRow(
            wInst,
            wFStart,
            wFEnd,
            wDStart,
            wDEnd,
            resolveCycle,
            reachedD,
            row.rowId,
            inst,
            resolveStage,
            penaltyCycles,
            predictionModeLabel,
            actualTaken
          );
          rows.push(flushedRow);
        }

        branchDelayTotal += penaltyCycles;

        branchPenalties.push({
          branchRowId: row.rowId,
          startCycle: resolveCycle - penaltyCycles + 1,
          endCycle: resolveCycle,
          penaltyCycles,
          resolveStage,
          instrText: inst.rawText,
          predictionModeLabel,
          actualTaken
        });

        hazardLogs.push({
          type: 'branch',
          title: `[Branch Penalty: ${penaltyCycles} Cycle${penaltyCycles > 1 ? 's' : ''}] ${inst.rawText}`,
          cycles: `Cycle ${resolveCycle - penaltyCycles + 1}` + (penaltyCycles > 1 ? ` ~ ${resolveCycle}` : ''),
          detail: `분기 목적지 주소와 분기 여부가 ${resolveStage} 단계(Cycle ${resolveCycle})에서 결정됩니다 (${predictionModeLabel}). ` +
            `그 결과 폐기되는 명령어의 ${options.secondAdder ? 'D 단계 위치' : '다음 사이클'}(Cycle ${resolveCycle + 1})에서 타겟 명령어의 F 단계가 시작되어 ` +
            `${penaltyCycles} 사이클의 Branch Penalty가 발생합니다 (교과서 Fig. ${options.secondAdder ? '6.10' : '6.9'}).`
        });

        currentFetchCycle = resolveCycle + 1;
        pc = actualTaken ? targetPc : pc + 1;
      }
    } else {
      // Normal sequential progression
      currentFetchCycle = row.fEnd + 1;
      pc = pc + 1;
    }
  }

  const totalCycles = rows.reduce((maxC, r) => Math.max(maxC, r.wEnd), 0);

  return {
    rows,
    totalCycles,
    forwardings,
    branchPenalties,
    hazardLogs,
    btbHistory,
    finalBtbState: lastBtbState,
    stats: {
      dataDelay: dataDelayTotal,
      memDelay: memDelayTotal,
      branchDelay: branchDelayTotal,
      totalDelay: dataDelayTotal + memDelayTotal + branchDelayTotal
    }
  };

  /**
   * Schedule a valid (non-flushed) instruction through F, D, C, M, W
   */
  function scheduleInstructionRow(inst, iterNum, desiredFStart) {
    const rowId = ++rowIdCounter;
    // Find previous valid / active row for structural stage ordering
    const prevRow = rows.length > 0 ? rows[rows.length - 1] : null;
    const activeRows = rows.filter(r => !r.isFlushed);
    const prevActive = activeRows.length > 0 ? activeRows[activeRows.length - 1] : null;

    // 1. Fetch Stage (F)
    let fStart = desiredFStart;
    if (prevRow && !prevRow.isFlushed) {
      fStart = Math.max(fStart, prevRow.fStart + 1);
    }

    // Check Single Unified Cache conflict (Sec 6.7): if any earlier active Load/Store is in M during fStart
    let fEnd = fStart;
    let fDelayReasons = [];
    if (options.unifiedCache) {
      while (true) {
        const conflictingMem = activeRows.find(
          r => (r.inst.type === 'LOAD' || r.inst.type === 'STORE') && fEnd >= r.mStart && fEnd <= r.mEnd
        );
        if (conflictingMem) {
          fDelayReasons.push({
            type: 'memory',
            cycles: 1,
            title: '단일 캐시 자원 충돌 (Sec. 6.7 Structural Hazard)',
            detail: `Cycle ${fEnd}에 앞서 실행 중인 '${conflictingMem.inst.rawText}' 명령어가 M 단계에서 단일 캐시(Single Cache)에 접근 중이므로, F 단계의 명령어 인출이 1 사이클 대기합니다.`
          });
          memDelayTotal += 1;
          fEnd += 1;
        } else {
          break;
        }
      }
    }

    // Also if previous instruction held D (interstage buffer B1), F must hold until previous instruction leaves D!
    // Wait: in textbook Figure 6.7, Ij+1 enters F at cycle 2, enters D at cycle 3; Ij+2 enters F at cycle 3, enters D at cycle 4.
    // What if Ij+1 is held in D during cycles 3..6 (like Subtract in Fig 6.3), and there is an Ij+2 after Subtract?
    // Then Ij+2 is fetched in cycle 3 and held in F (or B1) until cycle 6 when Subtract leaves D!
    let dStart = fEnd + 1;
    if (prevActive) {
      if (prevActive.dEnd >= dStart) {
        const holdF = prevActive.dEnd - fEnd;
        if (holdF > 0) {
          fDelayReasons.push({
            type: 'upstream',
            cycles: holdF,
            title: `앞 명령어('${prevActive.inst.rawText}') D 단계 대기로 인한 연쇄 지연`,
            detail: `앞선 '${prevActive.inst.rawText}' 명령어가 Cycle ${prevActive.dStart}~${prevActive.dEnd} 동안 Decode(B1 버퍼) 단계를 점유하고 있어, 현 명령어가 F 단계에서 ${holdF} 사이클 동안 대기했습니다.`
          });
          fEnd = prevActive.dEnd;
          dStart = fEnd + 1;
        }
      }
    }

    // 2. Decode Stage (D)
    let dEnd = dStart;
    let dDelayReasons = [];

    // Check if previous active instruction held C stage (buffer B2) beyond dStart
    if (prevActive && !prevActive.isBranch && prevActive.cEnd >= dEnd + 1) {
      const structuralWait = prevActive.cEnd - dEnd;
      if (structuralWait > 0) {
        dDelayReasons.push({
          type: 'upstream',
          cycles: structuralWait,
          title: `앞 명령어('${prevActive.inst.rawText}') C/M 단계 지연으로 인한 대기 (Fig. 6.7)`,
          detail: `앞선 명령어가 하위 파이프라인 단계(C/M)에서 지연되어 Cycle ${dStart}~${prevActive.cEnd} 동안 인터스테이지 버퍼 B1(D 단계)에서 ${structuralWait} 사이클 대기했습니다.`
        });
        dEnd = prevActive.cEnd;
      }
    }

    // Check RAW Data Dependencies on inst.srcRegs (including BRANCH_COND condition registers!)
    // - If inst is BRANCH_COND and Second Adder/Comparator is in Decode (options.secondAdder === true):
    //   The comparator is in the Decode stage (Sec 6.6.2, page 204), so the condition register(s) are needed during D (at dEnd)!
    // - Otherwise (all ALU, LOAD, STORE, or BRANCH_COND when comparator is in C):
    //   Operands are needed at the start of the C stage (cStart = dEnd + 1)!
    const needsInDecode = inst.type === 'BRANCH_COND' && options.secondAdder;

    if (inst.srcRegs && inst.srcRegs.length > 0) {
      inst.srcRegs.forEach(srcReg => {
        // Find most recent active producer instruction that writes to srcReg (or has sideEffectReg === srcReg)
        let producer = null;
        for (let i = activeRows.length - 1; i >= 0; i--) {
          const cand = activeRows[i];
          if (cand.inst.destReg === srcReg || cand.inst.sideEffectReg === srcReg) {
            producer = cand;
            break;
          }
        }

        if (!producer) return;

        const prodIsLoad = producer.inst.type === 'LOAD' && producer.inst.destReg === srcReg;
        const prodCEnd = producer.cEnd; // ALU result ready in RZ at prodCEnd + 1
        const prodMEnd = producer.mEnd; // Result ready in RY at prodMEnd + 1
        const prodWEnd = producer.wEnd; // Written to Register File at prodWEnd (readable in D at prodWEnd + 1)

        if (needsInDecode) {
          // Textbook Section 6.6.2 (page 204) & Figure 6.5:
          // "Similarly, the comparator that tests the branch condition can also be moved to the Decode stage...
          // In this case, the comparator uses the values from outputs A and B of the register file directly."
          // Because forwarding multiplexers (MuxA, MuxB) only feed the ALU inputs in the Compute (C) stage,
          // the Decode-stage comparator CANNOT receive forwarded values from RZ or RY; it must wait until
          // the producer instruction writes the new value into the Register File in stage W (prodWEnd),
          // reading it from the Register File in cycle (prodWEnd + 1)!
          const minDEnd = prodWEnd + 1;

          if (dEnd < minDEnd) {
            const stallCycles = minDEnd - dEnd;
            const waitStart = dEnd;
            const waitEnd = minDEnd - 1;
            dataDelayTotal += stallCycles;

            const reasonTitle = `Branch Condition Data Dependency (${srcReg}) — ${stallCycles} Cycle${stallCycles > 1 ? 's' : ''} 지연 (6.6.2절)`;
            const reasonDetail = `교과서 6.6.2절에 따라 Decode(D) 단계로 이동한 비교기(Comparator)는 포워딩 멀티플렉서(C 단계 ALU 앞의 MuxA/MuxB)를 거치지 않고 <strong>레지스터 파일의 출력 A, B를 직접 읽습니다</strong>. 따라서 '${producer.inst.rawText}' 명령어가 Cycle ${prodWEnd}(W 단계)에 레지스터 파일 쓰기를 마칠 때까지 Cycle ${waitStart}${waitEnd > waitStart ? `~${waitEnd}` : ''} 동안 D 단계에서 ${stallCycles} 사이클 대기한 뒤, Cycle ${minDEnd}에 '${srcReg}' 값을 읽습니다.`;
            const tipText = `Decode 단계 비교기는 RZ/RY Forwarding을 받을 수 없으므로, 컴파일러가 '${srcReg}' 값을 변경하는 명령어를 분기 명령어보다 앞쪽으로 재배치(Instruction Reordering)해야 이 지연을 줄일 수 있습니다.`;

            dDelayReasons.push({
              type: 'data',
              cycles: stallCycles,
              reg: srcReg,
              producerText: producer.inst.rawText,
              title: reasonTitle,
              detail: reasonDetail,
              tip: tipText
            });

            hazardLogs.push({
              type: 'data',
              title: `[${reasonTitle}] ${inst.rawText}`,
              cycles: `Cycle ${dStart} ~ ${minDEnd} (D 단계)`,
              detail: `${reasonDetail} 💡 ${tipText}`
            });

            dEnd = minDEnd;
          }
        } else {
          // Standard case: operand needed at start of C stage (cStart = dEnd + 1)
          const desiredCStart = dEnd + 1;
          let minCStart = prodWEnd + 2; // Without forwarding: D finishes at prodWEnd + 1, so C starts at prodWEnd + 2 (Fig. 6.3!)
          let usedForwarding = null;

          if (!prodIsLoad && options.fwdRZ && desiredCStart <= prodCEnd + 1) {
            // Can forward directly from RZ at cycle prodCEnd + 1!
            minCStart = prodCEnd + 1;
            usedForwarding = 'RZ';
          } else if (!prodIsLoad && options.fwdRZ && desiredCStart === prodMEnd + 1 && !options.fwdRY) {
            // Distance 2 when RZ is ON but RY is OFF!
            // In cycle prodMEnd + 1 (producer's W stage), producer's result is in RY (RZ was overwritten by intervening instruction!).
            // Since RY forwarding is OFF, consumer must wait for Register File write in W!
            minCStart = prodWEnd + 2;
            usedForwarding = null;
          } else if (options.fwdRY && desiredCStart <= prodMEnd + 1) {
            // Can forward from RY at cycle prodMEnd + 1!
            // - For ALU producer at distance 2 (Fig. 6.15): desiredCStart === prodMEnd + 1 -> 0 stall!
            // - For Load producer at distance 1 (Fig. 6.8): desiredCStart === prodCEnd + 1, waits 1 cycle in D until prodMEnd + 1!
            // - For ALU producer at distance 1 when RZ is OFF & RY is ON: waits 1 cycle in D until prodMEnd + 1!
            minCStart = prodMEnd + 1;
            usedForwarding = 'RY';
          } else if ((options.fwdRZ || options.fwdRY) && desiredCStart > prodMEnd + 1) {
            // Distance >= 3 with forwarding active: value is already available
            minCStart = desiredCStart;
          }

          const requiredDEnd = minCStart - 1;
          if (dEnd < requiredDEnd) {
            const stallCycles = requiredDEnd - dEnd;
            const waitStart = dEnd;
            const waitEnd = requiredDEnd - 1;
            dataDelayTotal += stallCycles;

            let reasonTitle = '';
            let reasonDetail = '';
            let tipText = '';

            if (prodIsLoad && options.fwdRY) {
              // Textbook Figure 6.8: Load-Use Data Dependency
              reasonTitle = `Load-Use Data Dependency (${srcReg}) — ${stallCycles} Cycle 지연 (Fig. 6.8)`;
              reasonDetail = `'${producer.inst.rawText}' 명령어가 메모리(캐시)에서 읽은 '${srcReg}' 데이터는 M 단계(Cycle ${prodMEnd})가 끝나고 버퍼 B4의 RY 레지스터에 적재되는 Cycle ${prodMEnd + 1}에야 사용할 수 있습니다. 따라서 D 단계(Cycle ${waitStart})에서 ${stallCycles} 사이클 대기한 후 Cycle ${minCStart}에 RY에서 ALU로 포워딩받습니다.`;
              tipText = `Load 직후 명령어의 1사이클 지연은 하드웨어 포워딩만으로는 제거할 수 없으며, 컴파일러가 사이에 독립적인 명령어를 재배치(Instruction Reordering)하여 줄일 수 있습니다 (교과서 6.5절).`;
            } else if (prodIsLoad && !options.fwdRY) {
              reasonTitle = `Load Data Dependency (${srcReg}, RY Forwarding 미사용) — ${stallCycles} Cycles 지연`;
              reasonDetail = `'${producer.inst.rawText}' 명령어가 Cycle ${prodWEnd}(W 단계)에 레지스터 파일에 '${srcReg}' 값을 쓸 때까지 기다려야 하므로, 인터스테이지 버퍼 B1(D 단계)에서 Cycle ${waitStart}~${waitEnd} 동안 ${stallCycles} 사이클 대기한 뒤 Cycle ${requiredDEnd}에 레지스터 파일을 읽습니다.`;
              tipText = `우측에서 'RY에서 Forwarding' 체크박스를 켜면 Load 결과가 M 단계 직후 RY에서 바로 전달되어 지연이 1 사이클로 줄어듭니다 (Fig. 6.8).`;
            } else if (!options.fwdRZ && !options.fwdRY) {
              // Textbook Figure 6.3: Classic 3-cycle RAW stall
              reasonTitle = `Data Dependency (${srcReg} RAW Hazard) — ${stallCycles} Cycles 지연 (Fig. 6.3)`;
              reasonDetail = `앞선 '${producer.inst.rawText}' 명령어의 목적지 레지스터 '${srcReg}'가 Cycle ${prodWEnd}(W 단계)에야 레지스터 파일에 기록됩니다. 따라서 '${inst.rawText}' 명령어는 Cycle ${waitStart}~${waitEnd} 동안 버퍼 B1(D 단계)에 머물며 ${stallCycles} 사이클 대기(Bubble 삽입)한 뒤, 새로운 값이 준비된 Cycle ${requiredDEnd}에 레지스터를 읽습니다.`;
              tipText = `우측에서 'RZ에서 Forwarding'(또는 거리 2인 경우 'RY에서 Forwarding')을 체크하면 ALU 결과를 기다리지 않고 바로 포워딩받아 지연을 0 사이클로 제거할 수 있습니다 (Fig. 6.4).`;
            } else if (!options.fwdRZ && options.fwdRY) {
              reasonTitle = `Data Dependency (${srcReg}, RZ Forwarding 미적용) — ${stallCycles} Cycle 지연`;
              reasonDetail = `RZ 포워딩이 꺼져 있어 '${producer.inst.rawText}'의 C 단계 직후 값을 바로 받지 못하고, 결과가 M 단계를 거쳐 버퍼 B4의 RY 레지스터에 도달하는 Cycle ${prodMEnd + 1}까지 D 단계에서 ${stallCycles} 사이클 대기했습니다.`;
              tipText = `'RZ에서 Forwarding'을 함께 체크하면 지연 없이 Cycle ${prodCEnd + 1}에 바로 실행됩니다.`;
            } else {
              reasonTitle = `Data Dependency (${srcReg}, RY Forwarding 미적용) — ${stallCycles} Cycles 지연`;
              reasonDetail = `'${producer.inst.rawText}'의 결과가 Cycle ${prodMEnd + 1}에는 버퍼 B4의 RY 레지스터에 위치하지만(RZ는 중간 명령어로 덮어써짐), RY 포워딩이 꺼져 있어 Cycle ${prodWEnd}(W 단계) 이후인 Cycle ${requiredDEnd}까지 ${stallCycles} 사이클 대기했습니다.`;
              tipText = `'RY에서 Forwarding'을 체크하면 버퍼 B4(RY)에서 ALU로 즉시 전달되어 지연이 0 사이클이 됩니다 (Fig. 6.15).`;
            }

            dDelayReasons.push({
              type: prodIsLoad ? 'load-use' : 'data',
              cycles: stallCycles,
              reg: srcReg,
              producerText: producer.inst.rawText,
              title: reasonTitle,
              detail: reasonDetail,
              tip: tipText
            });

            hazardLogs.push({
              type: prodIsLoad ? 'memory' : 'data',
              title: `[${reasonTitle}] ${inst.rawText}`,
              cycles: `Cycle ${dStart} ~ ${requiredDEnd} (D 단계)`,
              detail: `${reasonDetail}${tipText ? ' 💡 ' + tipText : ''}`
            });

            dEnd = requiredDEnd;
          }

          // Record forwarding arrow if forwarding was actually used at cStart = dEnd + 1
          const actualCStart = dEnd + 1;
          if (!prodIsLoad && options.fwdRZ && actualCStart === prodCEnd + 1) {
            forwardings.push({
              fromRowId: producer.rowId,
              fromStage: 'C',
              fromCycle: prodCEnd,
              toRowId: rowId,
              toStage: 'C',
              toCycle: actualCStart,
              reg: srcReg,
              bufferName: 'RZ',
              producerText: producer.inst.rawText,
              consumerText: inst.rawText
            });
            hazardLogs.push({
              type: 'resolved',
              title: `[Operand Forwarding: RZ → ALU] ${producer.inst.rawText} ➔ ${inst.rawText}`,
              cycles: `Cycle ${prodCEnd} (C) → Cycle ${actualCStart} (C)`,
              detail: `'${producer.inst.rawText}'가 Cycle ${prodCEnd}에 계산한 '${srcReg}' 값을 레지스터 파일 쓰기(W)까지 기다리지 않고, 인터스테이지 버퍼 B3의 RZ 레지스터에서 Cycle ${actualCStart}의 ALU 입력(MuxA/MuxB)으로 즉시 포워딩하여 스톨을 방지했습니다 (Fig. 6.4).`
            });
          } else if (options.fwdRY && actualCStart === prodMEnd + 1) {
            forwardings.push({
              fromRowId: producer.rowId,
              fromStage: 'M',
              fromCycle: prodMEnd,
              toRowId: rowId,
              toStage: 'C',
              toCycle: actualCStart,
              reg: srcReg,
              bufferName: 'RY',
              producerText: producer.inst.rawText,
              consumerText: inst.rawText
            });
            hazardLogs.push({
              type: 'resolved',
              title: `[Operand Forwarding: RY → ALU] ${producer.inst.rawText} ➔ ${inst.rawText}`,
              cycles: `Cycle ${prodMEnd} (M) → Cycle ${actualCStart} (C)`,
              detail: `'${producer.inst.rawText}'의 '${srcReg}' 결과값(인터스테이지 버퍼 B4의 RY 레지스터)을 Cycle ${actualCStart}에 '${inst.rawText}'의 ALU 입력으로 포워딩했습니다 (${prodIsLoad ? 'Fig. 6.8 Load Forwarding' : 'Fig. 6.15 RY Forwarding'}).`
            });
          }
        }
      });
    }

    // 3. Compute Stage (C)
    let cStart = dEnd + 1;
    let cEnd = cStart;
    let cDelayReasons = [];

    // Check if previous active instruction held M stage (buffer B3) beyond cStart (e.g. Fig 6.7 Cache Miss in M!)
    if (prevActive && !prevActive.isBranch && prevActive.mEnd >= cEnd + 1) {
      const mBusyWait = prevActive.mEnd - cEnd;
      if (mBusyWait > 0) {
        cDelayReasons.push({
          type: 'upstream',
          cycles: mBusyWait,
          title: `앞 명령어('${prevActive.inst.rawText}') Memory(M) 단계 지연으로 인한 대기 (Fig. 6.7)`,
          detail: `앞선 '${prevActive.inst.rawText}' 명령어가 Cache Miss로 인해 Cycle ${prevActive.mStart}~${prevActive.mEnd} 동안 M 단계를 점유하고 있어, 현 명령어가 인터스테이지 버퍼 B3로 진행하지 못하고 C 단계에서 ${mBusyWait} 사이클 대기했습니다.`
        });
        cEnd = prevActive.mEnd;
      }
    }

    // 4. Memory Stage (M)
    let mStart = cEnd + 1;
    let mEnd = mStart;
    let mDelayReasons = [];

    // Determine if this instruction is a Load/Store with Data Cache Miss
    let extraMissCycles = 0;
    if (inst.type === 'LOAD' || inst.type === 'STORE') {
      if (lineMissOverrides.has(inst.sourceLineIdx)) {
        extraMissCycles = lineMissOverrides.get(inst.sourceLineIdx);
      } else if (inst.inlineMiss !== null && inst.inlineMiss !== undefined) {
        extraMissCycles = inst.inlineMiss;
      } else {
        extraMissCycles = options.memMissCycles || 0;
      }
    }

    if (extraMissCycles > 0) {
      mEnd = mStart + extraMissCycles;
      memDelayTotal += extraMissCycles;
      const totalMCycles = 1 + extraMissCycles;
      const reasonObj = {
        type: 'memory',
        cycles: extraMissCycles,
        title: `Memory Access Delay (Data Cache Miss) — ${extraMissCycles} Cycles 추가 지연 (Fig. 6.7)`,
        detail: `'${inst.rawText}' 명령어가 M 단계에서 데이터에 접근할 때 Cache Miss가 발생하여 메인 메모리로부터 데이터를 가져오는 데 총 ${totalMCycles} 클럭 사이클(Cycle ${mStart}~${mEnd}, 기본 1사이클 + 지연 ${extraMissCycles}사이클)이 소요되었습니다. 이로 인해 뒤따르는 모든 명령어들도 동일하게 지연됩니다.`,
        tip: `명령어 옆의 'Cache Hit/Miss' 버튼이나 우측의 'Data Cache Miss 지연' 설정을 0 cycle(Cache Hit)로 변경하면 1 사이클 만에 완료됩니다.`
      };
      mDelayReasons.push(reasonObj);
      hazardLogs.push({
        type: 'memory',
        title: `[Memory Cache Miss: +${extraMissCycles} Cycles] ${inst.rawText}`,
        cycles: `Cycle ${mStart} ~ ${mEnd} (M 단계)`,
        detail: reasonObj.detail
      });
    }

    // 5. Write Stage (W)
    let wStart = mEnd + 1;
    let wEnd = wStart;

    const isBranch = inst.type === 'BRANCH_UNCOND' || inst.type === 'BRANCH_COND';
    const branchResolvedInD = isBranch && options.secondAdder;

    return {
      rowId,
      inst,
      iterNum,
      isFlushed: false,
      isBranch,
      branchResolvedInD,
      extraMissCycles,
      fStart,
      fEnd,
      dStart,
      dEnd,
      cStart,
      cEnd,
      mStart,
      mEnd,
      wStart,
      wEnd,
      fDelayReasons,
      dDelayReasons,
      cDelayReasons,
      mDelayReasons
    };
  }

  /**
   * Schedule an instruction that was fetched along a mispredicted / untaken branch path and then flushed (Fig. 6.9 & 6.10)
   */
  function scheduleFlushedRow(
    inst,
    fStart,
    fEnd,
    dStart,
    dEnd,
    flushCycle,
    reachedD,
    branchRowId,
    branchInst,
    resolveStage,
    totalFlushedCount,
    predLabel,
    actualTaken
  ) {
    const rowId = ++rowIdCounter;
    // In Fig 6.9 (resolveStage = 'C'):
    // - Ij+1 has F(row.dStart..row.dEnd), D(row.cStart..row.cEnd), and 3 shaded boxes (C, M, W)
    // - Ij+2 has F(row.cStart..row.cEnd), and 4 shaded boxes (D, C, M, W)
    // In Fig 6.10 (resolveStage = 'D'):
    // - Ij+1 has F(row.dStart..row.dEnd), and 4 shaded boxes (D, C, M, W starting at row.dEnd + 1),
    //   while the next target instruction's F starts at row.dEnd + 1 (directly at Ij+1's D slot!)
    const penaltyTooltip = {
      type: 'branch',
      cycles: totalFlushedCount,
      title: `Branch Penalty로 인해 폐기(Flush)된 명령어 — 총 ${totalFlushedCount} Cycle${totalFlushedCount > 1 ? 's' : ''} 손실`,
      detail: `앞선 분기 명령어('${branchInst.rawText}')의 목적지 주소와 분기 여부가 ${resolveStage} 단계(Cycle ${flushCycle})에서 확정되었습니다 (${predLabel}). ` +
        `그 결과 분기 결정 전에 인출되었던 '${inst.rawText}' 명령어는 폐기(Flush)되고, ` +
        `폐기되는 명령어의 ${reachedD ? 'C' : 'D'} 단계 자리(Cycle ${flushCycle + 1})에서 다음 타겟 명령어의 F 단계가 시작됩니다 (교과서 Fig. ${resolveStage === 'D' ? '6.10' : '6.9'}).`,
      tip: resolveStage === 'C'
        ? `우측에서 'Decode 단계에 Second Adder 추가'를 체크하면 분기 결정이 D 단계로 앞당겨져 폐기되는 명령어의 D 자리에서 다음 명령어 F가 시작되므로 Branch Penalty가 1 사이클로 줄어듭니다.`
        : `우측에서 'Static Branch Prediction' 또는 'Dynamic Branch Prediction'을 체크하면 F 단계에서 분기를 미리 예측하여 예측 성공 시 Branch Penalty를 0 사이클로 줄일 수 있습니다.`
    };

    const cSlot = reachedD ? dEnd + 1 : fEnd + 2;
    const mSlot = reachedD ? dEnd + 2 : fEnd + 3;
    const wSlot = reachedD ? dEnd + 3 : fEnd + 4;

    return {
      rowId,
      branchRowId,
      inst,
      iterNum: 1,
      isFlushed: true,
      reachedD,
      fStart,
      fEnd,
      dStart,
      dEnd,
      cStart: cSlot,
      cEnd: cSlot,
      mStart: mSlot,
      mEnd: mSlot,
      wStart: wSlot,
      wEnd: wSlot,
      flushCycle,
      penaltyTooltip
    };
  }
}

/**
 * Render the Textbook-Style Pipeline Execution Diagram & Metrics
 */
function renderSimulation() {
  const codeText = document.getElementById('code-input').value;
  const options = getCurrentOptions();
  const program = parseProgram(codeText);

  // Run current simulation
  const simResult = simulatePipeline(program, options);

  // Also run baseline simulation (all hardware mitigations OFF, keeping same memory/loop environment) to calculate saved cycles
  const baselineOptions = {
    ...options,
    fwdRZ: false,
    fwdRY: false,
    secondAdder: false,
    staticPred: false,
    dynamicPred: false
  };
  const baselineResult = simulatePipeline(program, baselineOptions);

  updateMetricsUI(simResult, baselineResult);
  renderDiagramDOM(simResult, options);
  renderHazardLogUI(simResult);
  renderBranchPredictorUI(simResult, options);
}

function getCurrentOptions() {
  const fwdRZ = document.getElementById('chk-fwd-rz').checked;
  const fwdRY = document.getElementById('chk-fwd-ry').checked;
  const secondAdder = document.getElementById('chk-second-adder').checked;
  const staticPred = document.getElementById('chk-static-pred').checked;
  const dynamicPred = document.getElementById('chk-dynamic-pred').checked;

  // Highlight checked option cards
  toggleOptionHighlight('item-fwd-rz', fwdRZ);
  toggleOptionHighlight('item-fwd-ry', fwdRY);
  toggleOptionHighlight('item-second-adder', secondAdder);
  toggleOptionHighlight('item-static-pred', staticPred);
  toggleOptionHighlight('item-dynamic-pred', dynamicPred);

  return {
    fwdRZ,
    fwdRY,
    secondAdder,
    staticPred,
    dynamicPred,
    staticMode: document.getElementById('sel-static-mode').value,
    dynBits: document.getElementById('sel-dyn-bits').value,
    dynInitState: document.getElementById('sel-dyn-init').value,
    memMissCycles: parseInt(document.getElementById('sel-mem-miss-cycles').value, 10) || 0,
    unifiedCache: document.getElementById('chk-unified-cache').checked,
    branchOutcome: document.getElementById('sel-branch-outcome').value,
    loopIters: parseInt(document.getElementById('sel-loop-iters').value, 10) || 2
  };
}

function toggleOptionHighlight(id, checked) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.toggle('checked', checked);
  }
}

function updateMetricsUI(simResult, baselineResult) {
  const activeCount = simResult.rows.filter(r => !r.isFlushed).length;
  const idealCycles = activeCount > 0 ? activeCount + 4 : 0;
  const savedCycles = Math.max(0, baselineResult.totalCycles - simResult.totalCycles);
  const cpi = activeCount > 0 ? (simResult.totalCycles / activeCount).toFixed(2) : '0.00';

  document.getElementById('metric-total-cycles').textContent = `${simResult.totalCycles} Cycles`;
  document.getElementById('metric-ideal-sub').textContent =
    `이상적 무지연 실행(${idealCycles} Cycles) 대비 +${Math.max(0, simResult.totalCycles - idealCycles)} Cycles`;

  document.getElementById('metric-total-delays').textContent = `${simResult.stats.totalDelay} Cycles`;
  document.getElementById('metric-delay-breakdown').textContent =
    `Data: ${simResult.stats.dataDelay} · Memory: ${simResult.stats.memDelay} · Branch: ${simResult.stats.branchDelay}`;

  document.getElementById('metric-saved-cycles').textContent =
    savedCycles > 0 ? `-${savedCycles} Cycles 단축` : `0 Cycles`;
  document.getElementById('metric-saved-sub').textContent =
    `기본 파이프라인(${baselineResult.totalCycles} Cycles) → 현재(${simResult.totalCycles} Cycles)`;

  document.getElementById('metric-cpi').textContent = `${cpi}`;
  document.getElementById('metric-instr-count').textContent =
    `유효 실행 명령어 ${activeCount}개 완료 (폐기 ${simResult.rows.filter(r => r.isFlushed).length}개)`;
}

/**
 * Build the Textbook-Style Pipeline Execution Diagram (matching Fig. 6.3, 6.4, 6.7, 6.8, 6.9, 6.10, 6.15)
 */
function renderDiagramDOM(simResult, options) {
  const root = document.getElementById('pipeline-diagram-root');
  const svg = document.getElementById('forwarding-svg');
  root.innerHTML = '';
  svg.innerHTML = '';

  if (simResult.rows.length === 0) {
    root.innerHTML = `<div style="padding:28px; text-align:center; color:#64748b;">왼쪽 입력창에 RISC 어셈블리 코드를 입력해 주세요.</div>`;
    return;
  }

  const totalCycles = Math.max(simResult.totalCycles, 6);
  const cellWidth = 52;

  // 1. Clock Cycle Header Row
  const headerRow = document.createElement('div');
  headerRow.className = 'clock-header-row';

  const clockLabel = document.createElement('div');
  clockLabel.className = 'clock-label-cell';
  clockLabel.innerHTML = `<span>Clock cycle</span><span class="time-arrow-header">⟶ Time</span>`;
  headerRow.appendChild(clockLabel);

  const numbersTrack = document.createElement('div');
  numbersTrack.className = 'clock-numbers-track';
  for (let c = 1; c <= totalCycles; c++) {
    const numEl = document.createElement('div');
    numEl.className = 'clock-cycle-num';
    numEl.textContent = c;
    numbersTrack.appendChild(numEl);
  }
  headerRow.appendChild(numbersTrack);
  root.appendChild(headerRow);

  // 2. Instruction Rows Container
  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'pipeline-rows-container';

  // Map frombranchRowId to penalty object
  const penaltyByBranchRow = new Map();
  simResult.branchPenalties.forEach(p => penaltyByBranchRow.set(p.branchRowId, p));

  simResult.rows.forEach((row, idx) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'pipeline-row';
    rowEl.dataset.rowId = row.rowId;

    // Left Instruction Label Cell
    const labelCell = document.createElement('div');
    labelCell.className = 'instr-label-cell' + (row.isFlushed ? ' discarded-instr-label' : '');

    const textSpan = document.createElement('span');
    textSpan.className = 'instr-text-main';
    textSpan.textContent = row.inst.displayText;
    textSpan.title = row.inst.displayText;
    labelCell.appendChild(textSpan);

    // Optional interactive Cache Miss toggle button for Load / Store instructions
    if (!row.isFlushed && (row.inst.type === 'LOAD' || row.inst.type === 'STORE') && row.inst.sourceLineIdx >= 0) {
      const hasMiss = row.extraMissCycles > 0;
      const missBtn = document.createElement('button');
      missBtn.type = 'button';
      missBtn.className = 'instr-miss-toggle' + (hasMiss ? ' active' : '');
      missBtn.textContent = hasMiss ? `Miss (+${row.extraMissCycles}c)` : 'Cache Hit';
      missBtn.title = '클릭하여 이 Load/Store 명령어의 Data Cache Miss (Fig. 6.7) 여부를 토글합니다.';
      missBtn.addEventListener('click', () => {
        if (hasMiss) {
          lineMissOverrides.set(row.inst.sourceLineIdx, 0);
        } else {
          lineMissOverrides.set(row.inst.sourceLineIdx, Math.max(2, options.memMissCycles || 2));
        }
        renderSimulation();
      });
      labelCell.appendChild(missBtn);
    } else if (row.isFlushed) {
      const badge = document.createElement('span');
      badge.className = 'instr-iter-badge';
      badge.style.background = '#e0f2fe';
      badge.style.color = '#0369a1';
      badge.textContent = '폐기됨';
      labelCell.appendChild(badge);
    }

    rowEl.appendChild(labelCell);

    // Right Stage Track
    const stageTrack = document.createElement('div');
    stageTrack.className = 'stage-track';
    stageTrack.style.width = `${totalCycles * cellWidth}px`;

    const strip = document.createElement('div');
    strip.className = 'stage-strip';
    strip.style.marginLeft = `${(row.fStart - 1) * cellWidth}px`;

    if (row.isFlushed) {
      // Flushed wrong-path instruction row (Figure 6.9 & 6.10 style)
      // F box
      strip.appendChild(createStageCell('F', row.fStart, row.fEnd, [], false, false));
      // D box (either active D in Fig 6.9 or flushed shaded in Fig 6.10)
      if (row.reachedD) {
        strip.appendChild(createStageCell('D', row.dStart, row.dEnd, [], false, false));
      } else {
        strip.appendChild(createFlushedCell(row.dStart, row.penaltyTooltip));
      }
      // Remaining 3 boxes (C, M, W slots) shaded blue as discarded
      strip.appendChild(createFlushedCell(row.cStart, row.penaltyTooltip));
      strip.appendChild(createFlushedCell(row.mStart, row.penaltyTooltip));
      strip.appendChild(createFlushedCell(row.wStart, row.penaltyTooltip));
    } else {
      // Active instruction row
      strip.appendChild(createStageCell('F', row.fStart, row.fEnd, row.fDelayReasons, false, row.rowId));
      strip.appendChild(createStageCell('D', row.dStart, row.dEnd, row.dDelayReasons, false, row.rowId));

      if (row.isBranch) {
        // Textbook Fig 6.9 & 6.10: Branch instruction shows F, D, C (if resolved in C) and light-blue boxes for unused stages
        if (row.branchResolvedInD) {
          strip.appendChild(createStageCell('', row.cStart, row.cEnd, [], true, row.rowId));
        } else {
          strip.appendChild(createStageCell('C', row.cStart, row.cEnd, row.cDelayReasons, false, row.rowId));
        }
        strip.appendChild(createStageCell('', row.mStart, row.mEnd, [], true, row.rowId));
        strip.appendChild(createStageCell('', row.wStart, row.wEnd, [], true, row.rowId));
      } else {
        strip.appendChild(createStageCell('C', row.cStart, row.cEnd, row.cDelayReasons, false, row.rowId));
        strip.appendChild(createStageCell('M', row.mStart, row.mEnd, row.mDelayReasons, false, row.rowId));
        strip.appendChild(createStageCell('W', row.wStart, row.wEnd, [], false, row.rowId));
      }
    }

    stageTrack.appendChild(strip);
    rowEl.appendChild(stageTrack);
    rowsContainer.appendChild(rowEl);

    // Check if the next row is the target after flushed rows so we can render the textbook "<---> Branch penalty" marker
    const nextRow = simResult.rows[idx + 1];
    if (row.isFlushed && (!nextRow || !nextRow.isFlushed)) {
      // Find corresponding branch penalty
      const matchingPenalty = simResult.branchPenalties.find(
        p => p.branchRowId === row.branchRowId
      );
      if (matchingPenalty) {
        const penRow = document.createElement('div');
        penRow.className = 'branch-penalty-annotation';

        const spacer = document.createElement('div');
        spacer.style.width = 'var(--instr-col-width)';
        spacer.style.minWidth = 'var(--instr-col-width)';
        penRow.appendChild(spacer);

        const marker = document.createElement('div');
        marker.className = 'branch-penalty-marker';
        marker.style.marginLeft = `${(matchingPenalty.startCycle - 1) * cellWidth}px`;
        marker.style.width = `${matchingPenalty.penaltyCycles * cellWidth}px`;

        marker.innerHTML = `
          <div class="penalty-guide-lines">
            <div class="penalty-arrow-line"></div>
          </div>
          <div class="penalty-text-label">Branch penalty (${matchingPenalty.penaltyCycles} cycle${matchingPenalty.penaltyCycles > 1 ? 's' : ''})</div>
        `;

        attachTooltipEvents(marker, {
          badgeText: 'Branch Delay (Control Hazard)',
          badgeClass: 'badge-branch',
          cyclesText: `${matchingPenalty.penaltyCycles} Cycle${matchingPenalty.penaltyCycles > 1 ? 's' : ''} Penalty`,
          title: `분기 페널티 (Branch Penalty: Cycle ${matchingPenalty.startCycle}${matchingPenalty.endCycle > matchingPenalty.startCycle ? `~${matchingPenalty.endCycle}` : ''})`,
          body: `'${matchingPenalty.instrText}' 명령어의 분기 결정 및 타겟 주소 계산이 <strong>${matchingPenalty.resolveStage} 단계(Cycle ${matchingPenalty.endCycle})</strong>에서 완료되었습니다. 그 사이 인출된 ${matchingPenalty.penaltyCycles}개의 명령어가 폐기되어 <strong>${matchingPenalty.penaltyCycles} 클럭 사이클의 Branch Penalty</strong>가 발생했습니다 (교과서 Fig. ${matchingPenalty.resolveStage === 'D' ? '6.10' : '6.9'}).`,
          tip: matchingPenalty.resolveStage === 'C'
            ? `Decode 단계에 Second Adder를 추가하면 Penalty가 1 사이클로 줄어들며, 분기 예측(Static/Dynamic Prediction)이 적중하면 0 사이클로 줄어듭니다.`
            : `Static 또는 Dynamic Branch Prediction을 활성화하면 예측 적중 시 Branch Penalty가 0 사이클로 사라집니다.`
        });

        penRow.appendChild(marker);
        rowsContainer.appendChild(penRow);
      }
    }
  });

  root.appendChild(rowsContainer);

  // 3. Draw SVG Forwarding Arrows (matching Figure 6.4, 6.8, 6.15)
  requestAnimationFrame(() => {
    drawForwardingArrows(simResult.forwardings);
  });
}

function createStageCell(stageLabel, startCycle, endCycle, delayReasons, isBranchIdle, rowId) {
  const cellWidth = 52;
  const spanCycles = endCycle - startCycle + 1;
  const box = document.createElement('div');
  box.className = 'stage-box';
  if (rowId && stageLabel) {
    box.dataset.rowStage = `${rowId}-${stageLabel}`;
  }
  box.style.width = `${spanCycles * cellWidth}px`;

  if (isBranchIdle) {
    box.classList.add('branch-idle-cell');
    return box;
  }

  const labelSpan = document.createElement('span');
  labelSpan.style.position = 'relative';
  labelSpan.style.zIndex = '2';
  labelSpan.textContent = stageLabel;
  box.appendChild(labelSpan);

  if (spanCycles > 1 && delayReasons && delayReasons.length > 0) {
    const primaryReason = delayReasons[0];
    box.classList.add('stretched-box', 'has-delay', `delay-${primaryReason.type}`);

    // Add sub-cycle dashed ticks inside the stretched box so user can see exact cycle boundaries
    const ticksContainer = document.createElement('div');
    ticksContainer.className = 'stretch-sub-ticks';
    for (let c = startCycle; c <= endCycle; c++) {
      const tick = document.createElement('div');
      tick.className = 'stretch-tick';
      ticksContainer.appendChild(tick);
    }
    box.appendChild(ticksContainer);

    // Add compact delay pill directly below the stretched box
    const totalDelay = spanCycles - 1;
    const pill = document.createElement('span');
    pill.className = 'delay-badge-pill';
    pill.textContent = `+${totalDelay} cycle${totalDelay > 1 ? 's' : ''} delay`;
    box.appendChild(pill);

    // Combine all delay reasons on this stage for the speech-bubble tooltip
    const combinedCycles = delayReasons.reduce((acc, r) => acc + r.cycles, 0);
    const badgeMap = {
      'data': { text: 'Data Dependency (RAW Hazard)', cls: '' },
      'load-use': { text: 'Memory Data Hazard (Load-Use)', cls: 'badge-mem' },
      'memory': { text: 'Memory Access Delay (Cache Miss)', cls: 'badge-mem' },
      'upstream': { text: 'Pipeline Stall (연쇄 대기)', cls: '' }
    };
    const bInfo = badgeMap[primaryReason.type] || { text: 'Pipeline Delay', cls: '' };

    attachTooltipEvents(box, {
      badgeText: bInfo.text,
      badgeClass: bInfo.cls,
      cyclesText: `${combinedCycles} Cycle${combinedCycles > 1 ? 's' : ''} 지연 (Cycle ${startCycle}~${endCycle})`,
      title: delayReasons.map(r => r.title).join(' + '),
      body: delayReasons.map(r => r.detail).join('<br/><br/>'),
      tip: delayReasons.map(r => r.tip).filter(Boolean).join(' ')
    });
  } else if (spanCycles > 1) {
    box.classList.add('stretched-box', 'delay-upstream');
    const ticksContainer = document.createElement('div');
    ticksContainer.className = 'stretch-sub-ticks';
    for (let c = startCycle; c <= endCycle; c++) {
      const tick = document.createElement('div');
      tick.className = 'stretch-tick';
      ticksContainer.appendChild(tick);
    }
    box.appendChild(ticksContainer);
  }

  return box;
}

function createFlushedCell(cycle, penaltyTooltip) {
  const box = document.createElement('div');
  box.className = 'stage-box branch-flushed-cell';
  box.style.width = `52px`;

  if (penaltyTooltip) {
    attachTooltipEvents(box, {
      badgeText: 'Branch Delay (Flushed Instruction)',
      badgeClass: 'badge-branch',
      cyclesText: `${penaltyTooltip.cycles} Cycle${penaltyTooltip.cycles > 1 ? 's' : ''} Branch Penalty`,
      title: penaltyTooltip.title,
      body: penaltyTooltip.detail,
      tip: penaltyTooltip.tip
    });
  }
  return box;
}

/**
 * Draw SVG Forwarding Arrows between producer C/M boxes and consumer C/D boxes (Figure 6.4, 6.8, 6.15)
 */
function drawForwardingArrows(forwardings) {
  const svg = document.getElementById('forwarding-svg');
  const wrapper = document.getElementById('pipeline-canvas-wrapper');
  if (!svg || !wrapper) return;

  const wrapperRect = wrapper.getBoundingClientRect();
  svg.setAttribute('width', wrapper.scrollWidth);
  svg.setAttribute('height', wrapper.scrollHeight);

  // Define arrowhead marker
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <marker id="fwd-arrow-rz" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#2563eb" />
    </marker>
    <marker id="fwd-arrow-ry" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#7c3aed" />
    </marker>
  `;
  svg.appendChild(defs);

  forwardings.forEach((fwd, idx) => {
    const fromEl = wrapper.querySelector(`[data-row-stage="${fwd.fromRowId}-${fwd.fromStage}"]`);
    const toEl = wrapper.querySelector(`[data-row-stage="${fwd.toRowId}-${fwd.toStage}"]`);
    if (!fromEl || !toEl) return;

    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();

    const x1 = fromRect.right - wrapperRect.left - 14;
    const y1 = fromRect.bottom - wrapperRect.top - 3;
    const x2 = toRect.left - wrapperRect.left + 16 + (idx * 6 % 14);
    const y2 = toRect.top - wrapperRect.top + 3;

    const color = fwd.bufferName === 'RZ' ? '#2563eb' : '#7c3aed';
    const markerId = fwd.bufferName === 'RZ' ? 'url(#fwd-arrow-rz)' : 'url(#fwd-arrow-ry)';

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '2.2');
    line.setAttribute('marker-end', markerId);
    svg.appendChild(line);

    // Small label badge along the arrow
    const midX = (x1 + x2) / 2 + 12;
    const midY = (y1 + y2) / 2;
    const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    badge.setAttribute('x', midX);
    badge.setAttribute('y', midY);
    badge.setAttribute('fill', color);
    badge.setAttribute('font-size', '10.5');
    badge.setAttribute('font-weight', '700');
    badge.setAttribute('font-family', 'Pretendard, sans-serif');
    badge.textContent = `${fwd.bufferName}(${fwd.reg})`;
    svg.appendChild(badge);
  });
}

/**
 * Speech-Bubble Tooltip (말풍선) Controller
 */
const tooltipEl = document.getElementById('delay-tooltip');

function attachTooltipEvents(targetEl, data) {
  targetEl.addEventListener('mouseenter', e => {
    showTooltip(data, e);
  });
  targetEl.addEventListener('mousemove', e => {
    positionTooltip(e);
  });
  targetEl.addEventListener('mouseleave', () => {
    hideTooltip();
  });
}

function showTooltip(data, event) {
  tooltipEl.innerHTML = `
    <div class="tooltip-header">
      <span class="tooltip-badge ${data.badgeClass || ''}">${data.badgeText}</span>
      <span class="tooltip-cycles">${data.cyclesText}</span>
    </div>
    <div class="tooltip-title">${data.title}</div>
    <div class="tooltip-body">${data.body}</div>
    ${data.tip ? `<div class="tooltip-tip">💡 <strong>해결 팁:</strong> ${data.tip}</div>` : ''}
  `;
  tooltipEl.classList.add('visible');
  positionTooltip(event);
}

function positionTooltip(event) {
  const pad = 14;
  const rect = tooltipEl.getBoundingClientRect();
  let left = event.clientX - rect.width / 2;
  let top = event.clientY - rect.height - 16;
  let flipBottom = false;

  if (left < pad) left = pad;
  if (left + rect.width > window.innerWidth - pad) {
    left = window.innerWidth - rect.width - pad;
  }

  if (top < pad) {
    top = event.clientY + 20;
    flipBottom = true;
  }

  const arrowLeft = Math.max(18, Math.min(rect.width - 18, event.clientX - left));
  tooltipEl.style.setProperty('--arrow-left', `${arrowLeft}px`);
  tooltipEl.classList.toggle('flip-bottom', flipBottom);
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function hideTooltip() {
  tooltipEl.classList.remove('visible');
}

/**
 * Render Bottom Section 4: Detailed Hazard & Forwarding Analysis Log
 */
function renderHazardLogUI(simResult) {
  const listEl = document.getElementById('hazard-log-list');
  if (simResult.hazardLogs.length === 0) {
    listEl.innerHTML = `
      <div class="hazard-card type-resolved">
        <div class="hazard-card-header">
          <span>모든 명령어가 이상적(Ideal) 파이프라인으로 실행됨</span>
          <span>Delay 0 Cycle</span>
        </div>
        <p>데이터 의존성, 메모리 접근 지연, 분기 페널티가 전혀 발생하지 않았습니다 (Fig. 6.1 Ideal Case).</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = simResult.hazardLogs
    .map(
      item => `
      <div class="hazard-card type-${item.type}">
        <div class="hazard-card-header">
          <span>${item.title}</span>
          <span style="font-size:0.76rem; color:#475569;">${item.cycles}</span>
        </div>
        <p style="color:#334155; font-size:0.8rem;">${item.detail}</p>
      </div>
    `
    )
    .join('');
}

/**
 * Render Bottom Section 5: Dynamic Branch Prediction State Machine & BTB Table (Figure 6.12)
 */
function renderBranchPredictorUI(simResult, options) {
  const container = document.getElementById('branch-predictor-panel');
  const is2State = options.dynBits === '2state';
  const currentState = simResult.finalBtbState;

  const statesHTML = is2State
    ? `
      <div class="fsm-states-row">
        <div class="fsm-node ${currentState === 'LNT' ? 'active-state' : ''}">
          LNT<div style="font-size:0.66rem; font-weight:400;">Likely Not Taken</div>
        </div>
        <div style="align-self:center; font-weight:700; color:#64748b;">⇄</div>
        <div class="fsm-node ${currentState === 'LT' ? 'active-state' : ''}">
          LT<div style="font-size:0.66rem; font-weight:400;">Likely Taken</div>
        </div>
      </div>
    `
    : `
      <div class="fsm-states-row">
        <div class="fsm-node ${currentState === 'SNT' ? 'active-state' : ''}">
          SNT<div style="font-size:0.65rem; font-weight:400;">Strongly Not Taken</div>
        </div>
        <div class="fsm-node ${currentState === 'LNT' ? 'active-state' : ''}">
          LNT<div style="font-size:0.65rem; font-weight:400;">Likely Not Taken</div>
        </div>
        <div class="fsm-node ${currentState === 'LT' ? 'active-state' : ''}">
          LT<div style="font-size:0.65rem; font-weight:400;">Likely Taken</div>
        </div>
        <div class="fsm-node ${currentState === 'ST' ? 'active-state' : ''}">
          ST<div style="font-size:0.65rem; font-weight:400;">Strongly Taken</div>
        </div>
      </div>
    `;

  let historyHTML = '';
  if (!options.dynamicPred) {
    historyHTML = `<p style="font-size:0.8rem; color:#64748b; margin-top:8px;">우측의 <strong>'Dynamic Branch Prediction'</strong> 체크박스를 켜면 분기 명령어 실행 시 BTB(Branch Target Buffer) 상태 전이 기록이 여기에 표시됩니다.</p>`;
  } else if (simResult.btbHistory.length === 0) {
    historyHTML = `<p style="font-size:0.8rem; color:#64748b; margin-top:8px;">현재 코드에 실행된 분기 명령어(Branch)가 없습니다. <em>'Sec 6.6.4: Loop &amp; Branch Prediction'</em> 예제를 눌러 확인해 보세요.</p>`;
  } else {
    historyHTML = `
      <table class="btb-history-table">
        <thead>
          <tr>
            <th>회차</th>
            <th>분기 명령어</th>
            <th>이전 상태</th>
            <th>BTB 예측</th>
            <th>실제 결과</th>
            <th>판정</th>
            <th>다음 상태</th>
          </tr>
        </thead>
        <tbody>
          ${simResult.btbHistory
            .map(
              h => `
            <tr>
              <td>#${h.pass}</td>
              <td style="font-family:monospace;">${h.instrText}</td>
              <td><strong>${h.stateBefore}</strong></td>
              <td>${h.predicted}</td>
              <td>${h.actual}</td>
              <td class="${h.hit ? 'pred-hit' : 'pred-miss'}">${h.hit ? '적중 (0 Penalty)' : '실패 (Flush)'}</td>
              <td><strong>${h.stateAfter}</strong></td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  container.innerHTML = `
    <div class="state-machine-box">
      <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.82rem;">
        <strong>${is2State ? 'Figure 6.12a: 2-State 알고리즘' : 'Figure 6.12b: 4-State 알고리즘'}</strong>
        <span style="color:#475569;">현재 상태: <strong style="color:#2563eb;">${currentState}</strong></span>
      </div>
      ${statesHTML}
      ${historyHTML}
    </div>
  `;
}

/**
 * Wire up UI event listeners
 */
function initApp() {
  const codeInput = document.getElementById('code-input');
  const controlIds = [
    'chk-fwd-rz',
    'chk-fwd-ry',
    'chk-second-adder',
    'chk-static-pred',
    'chk-dynamic-pred',
    'sel-static-mode',
    'sel-dyn-bits',
    'sel-dyn-init',
    'sel-mem-miss-cycles',
    'chk-unified-cache',
    'sel-branch-outcome',
    'sel-loop-iters'
  ];

  codeInput.addEventListener('input', () => {
    lineMissOverrides.clear();
    renderSimulation();
  });

  controlIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        // If Static and Dynamic prediction are mutually exclusive in typical use, let both work or prioritize cleanly
        if (id === 'chk-static-pred' && el.checked) {
          document.getElementById('chk-dynamic-pred').checked = false;
          document.getElementById('chk-second-adder').checked = true;
        } else if (id === 'chk-dynamic-pred' && el.checked) {
          document.getElementById('chk-static-pred').checked = false;
          document.getElementById('chk-second-adder').checked = true;
        }
        renderSimulation();
      });
    }
  });

  // Preset buttons
  document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.preset;
      const preset = PRESETS[key];
      if (!preset) return;

      document.querySelectorAll('.preset-btn[data-preset]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      lineMissOverrides.clear();
      codeInput.value = preset.code;

      const s = preset.settings;
      document.getElementById('chk-fwd-rz').checked = !!s.fwdRZ;
      document.getElementById('chk-fwd-ry').checked = !!s.fwdRY;
      document.getElementById('chk-second-adder').checked = !!s.secondAdder;
      document.getElementById('chk-static-pred').checked = !!s.staticPred;
      document.getElementById('chk-dynamic-pred').checked = !!s.dynamicPred;
      document.getElementById('sel-mem-miss-cycles').value = String(s.memMissCycles || 0);
      document.getElementById('chk-unified-cache').checked = !!s.unifiedCache;
      document.getElementById('sel-branch-outcome').value = s.branchOutcome || 'loop_taken';
      document.getElementById('sel-loop-iters').value = String(s.loopIters || 2);

      renderSimulation();
    });
  });

  // Check All / Uncheck All buttons
  document.getElementById('btn-check-all').addEventListener('click', () => {
    document.getElementById('chk-fwd-rz').checked = true;
    document.getElementById('chk-fwd-ry').checked = true;
    document.getElementById('chk-second-adder').checked = true;
    document.getElementById('chk-static-pred').checked = false;
    document.getElementById('chk-dynamic-pred').checked = true;
    renderSimulation();
  });

  document.getElementById('btn-uncheck-all').addEventListener('click', () => {
    document.getElementById('chk-fwd-rz').checked = false;
    document.getElementById('chk-fwd-ry').checked = false;
    document.getElementById('chk-second-adder').checked = false;
    document.getElementById('chk-static-pred').checked = false;
    document.getElementById('chk-dynamic-pred').checked = false;
    renderSimulation();
  });

  window.addEventListener('resize', () => {
    renderSimulation();
  });

  renderSimulation();
}

document.addEventListener('DOMContentLoaded', initApp);
