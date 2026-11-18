import { LessonPlayer } from "./(components)/LessonPlayer"

type Params = {
    params: Promise<{id: string, lessonId: string}>
}

export default async function getLessonPage({params}: Params){
    const courseId = (await params).id;
    const lessonId = (await params).lessonId;
    return <LessonPlayer courseId={courseId} lessonId={lessonId}/>
}