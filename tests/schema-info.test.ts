import { describe, expect, it } from 'vitest';
import { importSql } from '../src/lib/sql/import';
import { emptyDiagram } from '../src/lib/model';
import { fkTargetIsUnique, isJoinTable, isUniqueColumnSet, relationshipCardinality } from '../src/lib/schemaInfo';

const SQL = `
CREATE TABLE students (id SERIAL PRIMARY KEY, email TEXT UNIQUE);
CREATE TABLE courses (id SERIAL PRIMARY KEY);
CREATE TABLE enrollments (
  student_id INTEGER NOT NULL REFERENCES students(id),
  course_id INTEGER REFERENCES courses(id),
  PRIMARY KEY (student_id, course_id)
);
CREATE TABLE profiles (id SERIAL PRIMARY KEY, student_id INTEGER NOT NULL UNIQUE REFERENCES students(id));
CREATE TABLE notes (id SERIAL PRIMARY KEY, course_id INTEGER REFERENCES courses(id));
`;

function diagram() {
  const d = emptyDiagram('postgresql');
  const res = importSql(SQL, 'postgresql');
  d.tables = res.tables;
  d.relationships = res.relationships;
  return d;
}

describe('schemaInfo', () => {
  it('recognises unique column sets', () => {
    const d = diagram();
    const students = d.tables.find((t) => t.name === 'students')!;
    const email = students.columns.find((c) => c.name === 'email')!;
    const id = students.columns.find((c) => c.name === 'id')!;
    expect(isUniqueColumnSet(students, [id.id])).toBe(true);
    expect(isUniqueColumnSet(students, [email.id])).toBe(true);
    expect(isUniqueColumnSet(students, [id.id, email.id])).toBe(false);
    const enrollments = d.tables.find((t) => t.name === 'enrollments')!;
    expect(isUniqueColumnSet(enrollments, enrollments.columns.map((c) => c.id))).toBe(true);
    expect(isUniqueColumnSet(enrollments, [enrollments.columns[0].id])).toBe(false);
  });

  it('derives cardinality and join tables', () => {
    const d = diagram();
    const enrollments = d.tables.find((t) => t.name === 'enrollments')!;
    const profiles = d.tables.find((t) => t.name === 'profiles')!;
    expect(isJoinTable(d, enrollments)).toBe(true);
    expect(isJoinTable(d, profiles)).toBe(false);
    const toCourses = d.relationships.find((r) => r.sourceTableId === enrollments.id && d.tables.find((t) => t.id === r.targetTableId)?.name === 'courses')!;
    expect(relationshipCardinality(d, toCourses)).toEqual({ source: 'N', sourceOptional: false, target: '1' });
    const notes = d.tables.find((t) => t.name === 'notes')!;
    const optional = d.relationships.find((r) => r.sourceTableId === notes.id)!;
    expect(relationshipCardinality(d, optional)).toEqual({ source: 'N', sourceOptional: true, target: '1' });
    const oneToOne = d.relationships.find((r) => r.sourceTableId === profiles.id)!;
    expect(relationshipCardinality(d, oneToOne)).toEqual({ source: '1', sourceOptional: false, target: '1' });
    expect(fkTargetIsUnique(d, oneToOne)).toBe(true);
  });
});
