import { sha256Hex } from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";
import {
  type JsonObject,
  type JsonValue,
  parseStrictJson,
} from "../../../tools/yuansheng-root-cause-blueprint/src/strict-json";

export const SG2044_PROFILE_ID = "sg2044" as const;
export const SG2044_SOURCE_SHA256 =
  "e55c865f09c0e0ede3248afa6a1a3dc9b8b3187fd3052eb0691633951419029f" as const;

export interface Sg2044HardwareProfile {
  readonly core: "XuanTie C920v2";
  readonly core_vendor: "T-Head";
  readonly cpuinfo: Readonly<{
    isa: "rv64imafdcv_zicbom_zicboz_zicntr_zicond_zicsr_zifencei_zihintntl_zihintpause_zihpm_zawrs_zfa_zfh_zfhmin_zca_zcb_zcd_zba_zbb_zbc_zbs_zve32f_zve32x_zve64d_zve64f_zve64x_zvfh_zvfhmin_sscofpmf_sstc_svinval_svnapot_svpbmt";
    model_name: "T-Head C920v2 (mvendorid=0x5b7, marchid=0x80000000090c0d00)";
  }>;
  readonly "instruction scheduling method": "out-of-order";
  readonly soc: "SG2044";
  readonly vector: Readonly<{
    flavor: "RVV 1.0";
    vlen_bits: 128;
    vlenb: 16;
  }>;
  readonly vendor: "SOPHGO";
}

export interface ConfirmedHardwareProfile {
  readonly id: typeof SG2044_PROFILE_ID;
  readonly profile: Readonly<Sg2044HardwareProfile>;
  readonly sha256: typeof SG2044_SOURCE_SHA256;
}

export type HardwareProfileErrorCode = "profile-hash-mismatch" | "profile-shape-invalid";

export class HardwareProfileError extends Error {
  constructor(
    readonly code: HardwareProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HardwareProfileError";
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function requireSg2044Shape(value: JsonValue): Sg2044HardwareProfile {
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, [
      "vendor",
      "soc",
      "core_vendor",
      "core",
      "instruction scheduling method",
      "vector",
      "cpuinfo",
    ]) ||
    value.vendor !== "SOPHGO" ||
    value.soc !== "SG2044" ||
    value.core_vendor !== "T-Head" ||
    value.core !== "XuanTie C920v2" ||
    value["instruction scheduling method"] !== "out-of-order"
  ) {
    throw new HardwareProfileError(
      "profile-shape-invalid",
      "SG2044 hardware profile does not match the recorded shape",
    );
  }

  const vector = value.vector;
  const cpuinfo = value.cpuinfo;
  if (
    vector === undefined ||
    !isJsonObject(vector) ||
    !hasExactKeys(vector, ["flavor", "vlen_bits", "vlenb"]) ||
    vector.flavor !== "RVV 1.0" ||
    vector.vlen_bits !== 128 ||
    vector.vlenb !== 16 ||
    cpuinfo === undefined ||
    !isJsonObject(cpuinfo) ||
    !hasExactKeys(cpuinfo, ["model_name", "isa"]) ||
    cpuinfo.model_name !== "T-Head C920v2 (mvendorid=0x5b7, marchid=0x80000000090c0d00)" ||
    cpuinfo.isa !==
      "rv64imafdcv_zicbom_zicboz_zicntr_zicond_zicsr_zifencei_zihintntl_zihintpause_zihpm_zawrs_zfa_zfh_zfhmin_zca_zcb_zcd_zba_zbb_zbc_zbs_zve32f_zve32x_zve64d_zve64f_zve64x_zvfh_zvfhmin_sscofpmf_sstc_svinval_svnapot_svpbmt"
  ) {
    throw new HardwareProfileError(
      "profile-shape-invalid",
      "SG2044 hardware profile does not match the recorded shape",
    );
  }

  return Object.freeze({
    core: value.core,
    core_vendor: value.core_vendor,
    cpuinfo: Object.freeze({
      isa: cpuinfo.isa,
      model_name: cpuinfo.model_name,
    }),
    "instruction scheduling method": value["instruction scheduling method"],
    soc: value.soc,
    vector: Object.freeze({
      flavor: vector.flavor,
      vlen_bits: vector.vlen_bits,
      vlenb: vector.vlenb,
    }),
    vendor: value.vendor,
  });
}

export function parseSg2044HardwareProfile(input: Uint8Array): ConfirmedHardwareProfile {
  const value = parseStrictJson(input);
  const actualSha256 = sha256Hex(input);
  if (actualSha256 !== SG2044_SOURCE_SHA256) {
    throw new HardwareProfileError(
      "profile-hash-mismatch",
      `SG2044 hardware profile SHA-256 mismatch: expected ${SG2044_SOURCE_SHA256}, received ${actualSha256}`,
    );
  }

  return Object.freeze({
    id: SG2044_PROFILE_ID,
    profile: requireSg2044Shape(value),
    sha256: SG2044_SOURCE_SHA256,
  });
}
