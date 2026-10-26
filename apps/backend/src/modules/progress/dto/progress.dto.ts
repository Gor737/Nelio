import { ApiProperty } from '@nestjs/swagger';

export class ProgressSummaryDto {
  @ApiProperty({
    description:
      'Published lessons of the course that this student has completed.',
  })
  completedLessons!: number;

  @ApiProperty({ description: 'Lessons published right now.' })
  totalLessons!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description:
      'Live whole percent, rounded down (0 with no published lesson). It is independent of course completion: a completed student can show less than 100 after new lessons are published.',
  })
  percent!: number;
}

export class LessonCompletionDto {
  @ApiProperty({ format: 'uuid' })
  lessonId!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'When the lesson was first marked complete; unchanged by repeats.',
  })
  completedAt!: Date;

  @ApiProperty({
    description:
      'True only in the response to the request that completed the whole course (the permanent completion snapshot was written by this request). False on repeats and when the course is not finished.',
  })
  courseCompleted!: boolean;

  @ApiProperty({ type: ProgressSummaryDto })
  progress!: ProgressSummaryDto;
}
