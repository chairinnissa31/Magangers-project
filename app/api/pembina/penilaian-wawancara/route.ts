
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const FORMAT_MARKER = "__PENILAIAN_WAWANCARA_V1__";

function parseCatatan(raw: unknown) {
  const empty = {
    catatan: typeof raw === "string" ? raw : "",
    penjelasan: {},
  };

  if (typeof raw !== "string" || !raw) return empty;

  const markerIndex = raw.indexOf(FORMAT_MARKER);
  if (markerIndex === -1) return empty;

  try {
    const parsed = JSON.parse(
      raw.slice(markerIndex + FORMAT_MARKER.length).trim()
    );

    return {
      catatan:
        typeof parsed.catatan === "string"
          ? parsed.catatan
          : raw.slice(0, markerIndex).trim(),
      penjelasan:
        parsed.penjelasan &&
        typeof parsed.penjelasan === "object" &&
        !Array.isArray(parsed.penjelasan)
          ? parsed.penjelasan
          : {},
    };
  } catch {
    return empty;
  }
}

export async function GET(req: Request) {
  try {
    const authorization = req.headers.get("authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return NextResponse.json(
        { message: "Sesi login tidak valid. Silakan login ulang." },
        { status: 401 }
      );
    }

    const token = authorization.slice(7);
    const { data: authData, error: authError } =
      await supabase.auth.getUser(token);

    if (authError || !authData.user) {
      return NextResponse.json(
        { message: "Sesi login tidak valid. Silakan login ulang." },
        { status: 401 }
      );
    }

    // Pastikan akun yang login terdaftar sebagai pembimbing.
    const admin = supabaseAdmin();

    const { data: pembimbing, error: pembimbingError } = await admin
      .from("pembimbing")
      .select("id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    if (pembimbingError) {
      throw new Error(
        `Gagal memeriksa data pembimbing: ${pembimbingError.message}`
      );
    }

    if (!pembimbing) {
      return NextResponse.json(
        { message: "Akun ini tidak terdaftar sebagai pembimbing." },
        { status: 403 }
      );
    }

    // Ambil semua jadwal agar peserta tanpa penempatan tidak hilang.
    const { data: schedules, error: scheduleError } = await admin
      .from("jadwal_wawancara")
      .select(
        "id, peserta_id, interviewer, tanggal, jam, metode, lokasi, status"
      )
      .order("tanggal", { ascending: false })
      .order("jam", { ascending: false });

    if (scheduleError) {
      throw new Error(
        `Gagal mengambil jadwal wawancara: ${scheduleError.message}`
      );
    }

    const jadwalIds = (schedules ?? []).map((item) => item.id);
    const pesertaIds = [
      ...new Set(
        (schedules ?? [])
          .map((item) => item.peserta_id)
          .filter(Boolean)
          .map(String)
      ),
    ];

    let participants: Record<string, unknown>[] = [];
    let scores: Record<string, unknown>[] = [];

    if (pesertaIds.length > 0) {
      const { data, error } = await admin
        .from("peserta")
        .select("id, nama_lengkap, email, sekolah, jurusan")
        .in("id", pesertaIds);

      if (error) {
        throw new Error(`Gagal mengambil data peserta: ${error.message}`);
      }

      participants = (data ?? []) as Record<string, unknown>[];
    }

    if (jadwalIds.length > 0) {
      const { data, error } = await admin
        .from("penilaian_wawancara")
        .select(
          "id, jadwal_wawancara_id, peserta_id, komunikasi, motivasi, kemampuan_dasar, pemecahan_masalah, kesiapan_magang, catatan, created_at, updated_at"
        )
        .in("jadwal_wawancara_id", jadwalIds)
        .order("updated_at", { ascending: false });

      if (error) {
        throw new Error(`Gagal mengambil nilai wawancara: ${error.message}`);
      }

      scores = (data ?? []) as Record<string, unknown>[];
    }

    const participantMap = new Map(
      participants.map((item) => [String(item.id), item])
    );

    const normalizedSchedules = (schedules ?? []).map((item) => ({
      ...item,
      id: String(item.id),
      peserta_id: String(item.peserta_id),
      peserta: participantMap.get(String(item.peserta_id)) ?? null,
    }));

    const normalizedScores = scores.map((item) => ({
      ...item,
      ...parseCatatan(item.catatan),
      id: String(item.id),
      jadwal_wawancara_id: String(item.jadwal_wawancara_id),
      peserta_id: String(item.peserta_id),
    }));

    return NextResponse.json({
      schedules: normalizedSchedules,
      scores: normalizedScores,
    });
  } catch (error) {
    console.error("GET pembina penilaian wawancara:", error);

    return NextResponse.json(
      {
        message: "Gagal mengambil hasil penilaian wawancara.",
        detail:
          error instanceof Error
            ? error.message
            : "Kesalahan tidak diketahui.",
      },
      { status: 500 }
    );
  }
}
