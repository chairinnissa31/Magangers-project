
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

  const prefix = raw.slice(0, markerIndex).trim();

  try {
    const parsed = JSON.parse(
      raw.slice(markerIndex + FORMAT_MARKER.length).trim()
    );

    return {
      catatan:
        typeof parsed.catatan === "string"
          ? parsed.catatan
          : prefix,
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
        { message: "Sesi login tidak valid." },
        { status: 401 }
      );
    }

    const token = authorization.slice(7);

    // Validasi token melalui Supabase Auth.
    const { data: authData, error: authError } =
      await supabase.auth.getUser(token);

    if (authError || !authData.user) {
      return NextResponse.json(
        { message: "Sesi login tidak valid. Silakan login ulang." },
        { status: 401 }
      );
    }

    const admin = supabaseAdmin();
    const userId = authData.user.id;

    // Pastikan akun terdaftar sebagai pembimbing.
    const { data: pembimbing, error: pembimbingError } = await admin
      .from("pembimbing")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

    if (pembimbingError) {
      return NextResponse.json(
        {
          message: "Gagal memeriksa data pembimbing.",
          detail: pembimbingError.message,
        },
        { status: 500 }
      );
    }

    if (!pembimbing) {
      return NextResponse.json(
        { message: "Akun ini tidak terdaftar sebagai pembimbing." },
        { status: 403 }
      );
    }

    // Batasi hasil ke peserta yang ditempatkan pada pembimbing ini.
    const { data: placements, error: placementError } = await admin
      .from("penempatan")
      .select("peserta_id")
      .eq("pembimbing_id", pembimbing.id);

    if (placementError) {
      return NextResponse.json(
        {
          message: "Gagal mengambil peserta bimbingan.",
          detail: placementError.message,
        },
        { status: 500 }
      );
    }

    const pesertaIds = [
      ...new Set(
        (placements ?? [])
          .map((item) => item.peserta_id)
          .filter((id): id is string => Boolean(id))
          .map(String)
      ),
    ];

    if (pesertaIds.length === 0) {
      return NextResponse.json({ data: [] });
    }

    // Ambil hanya jadwal wawancara milik peserta bimbingan.
    const { data: schedules, error: scheduleError } = await admin
      .from("jadwal_wawancara")
      .select("id, peserta_id")
      .in("peserta_id", pesertaIds);

    if (scheduleError) {
      return NextResponse.json(
        {
          message: "Gagal mengambil jadwal wawancara.",
          detail: scheduleError.message,
        },
        { status: 500 }
      );
    }

    const jadwalIds = (schedules ?? []).map((item) => item.id);

    if (jadwalIds.length === 0) {
      return NextResponse.json({ data: [] });
    }

    const { data: scores, error: scoreError } = await admin
      .from("penilaian_wawancara")
      .select(`
        id,
        jadwal_wawancara_id,
        peserta_id,
        komunikasi,
        motivasi,
        kemampuan_dasar,
        pemecahan_masalah,
        kesiapan_magang,
        catatan,
        created_at,
        updated_at
      `)
      .in("jadwal_wawancara_id", jadwalIds)
      .order("updated_at", { ascending: false });

    if (scoreError) {
      return NextResponse.json(
        {
          message: "Gagal mengambil hasil penilaian wawancara.",
          detail: scoreError.message,
        },
        { status: 500 }
      );
    }

    const data = (scores ?? []).map((score) => ({
      ...score,
      ...parseCatatan(score.catatan),
    }));

    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      {
        message: "Terjadi kesalahan saat mengambil hasil wawancara.",
        detail:
          error instanceof Error ? error.message : "Kesalahan tidak diketahui.",
      },
      { status: 500 }
    );
  }
}
