/** One résumé bullet from the source of truth. `tags` are the skills/keywords
 *  it legitimately evidences — the ground truth the verifier checks against. */
export interface Bullet {
  id: string;
  text: string;
  tags: string[];
}

export interface Entry {
  company: string;
  role: string;
  start: string;
  end: string;
  bullets: Bullet[];
}

export interface EducationItem {
  school: string;
  degree: string;
  start: string;
  end: string;
  detail?: string;
}

export interface ResumeSource {
  basics: {
    name: string;
    email: string;
    phone?: string;
    location?: string;
    links?: string[];
  };
  experience: Entry[];
  education: EducationItem[];
  skills: string[];
}

export interface TailoredBullet {
  id: string;
  text: string;
  /** JD keywords this bullet matched — why it was surfaced. */
  matched: string[];
}

export interface TailoredEntry {
  company: string;
  role: string;
  start: string;
  end: string;
  bullets: TailoredBullet[];
}

export interface TailoredResume {
  basics: ResumeSource['basics'];
  experience: TailoredEntry[];
  education: EducationItem[];
  skills: string[];
  /** The JD keywords this tailoring targeted. */
  keywords: string[];
}

export interface Violation {
  entry: string;
  bulletId: string;
  reason: string;
}
