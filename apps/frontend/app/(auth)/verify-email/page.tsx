import { VerifyEmailPage } from "../components/VerifyEmail";
import styles from "../components/styles/VerifyEmail.module.css";

type Props = {
    searchParams: Promise<{"token": string}>
} 

export default async function VerifyEmail({searchParams}: Props){

    const {token} = await searchParams;
    console.log(token);
    if(typeof token !== 'string') return <p className={`${styles.state} ${styles.error}`}>Verification failed</p>

    return(
        <VerifyEmailPage token={token}/> 
    )
}