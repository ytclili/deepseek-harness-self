import React from 'react'
import ReactDOM from 'react-dom/client'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'antd/dist/reset.css'
import SchedulerPreview from '../SchedulerPreview'
import '../styles.css'

dayjs.locale('zh-cn')
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><SchedulerPreview /></React.StrictMode>)
